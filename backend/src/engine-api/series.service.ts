import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import Decimal from 'decimal.js';
import { hostname } from 'os';
import { PgLease } from '../engine/supervisor/lease';
import { Alerter, Logger as EngineLogger, VenueSpecs, systemClock } from '../engine/types';
import { marketCloseAt, marketLastPrice, marketSpecs } from '../engine/venue/markets';
import { PaperVenue } from '../engine/venue/paper-venue';
import { owed, reserveOf } from '../series/accounting';
import { SeriesEngine } from '../series/engine';
import { parseSeriesOrderId } from '../series/order-id';
import { PgSeriesStore } from '../series/pg-store';
import { roundDown } from '../engine/lattice';
import { SeriesSettingsError, buildPlan, buybackPrice, defaultSeriesSettings, resellPrice } from '../series/plan';
import { SeriesRunner } from '../series/runner';
import {
  SERIES_PAIRS, SeriesCycle, SeriesDirection, SeriesRun, SeriesSettings, SeriesSymbol, SeriesVenue, Slot, VENUE_PAIRS, assetOf, directionOf,
  isSeriesVenue, orderKind, seriesLabel, symbolOf, venueOf,
} from '../series/types';
import { EngineApiService } from './engine-api.service';

const ZERO = new Decimal(0);
const LEASE_TTL_SECONDS = 30;
const DAY_MS = 86_400_000;
/** Daily reset time: 00:00 in Pakistan (UTC+5, no daylight saving) is 19:00 UTC. */
const RESET_UTC_OFFSET_MS = 19 * 3_600_000;
/** Simulations one user can run at the same time, per exchange (20 on Bybit and 20 on MEXC). */
export const MAX_RUNNING_PER_USER = 20;

/** The most recent daily reset moment at or before `now`. */
export function lastResetBoundary(now: number): number {
  return Math.floor((now - RESET_UTC_OFFSET_MS) / DAY_MS) * DAY_MS + RESET_UTC_OFFSET_MS;
}

interface Live {
  ownerId: string;
  run: SeriesRun;
  engine: SeriesEngine;
  runner: SeriesRunner;
  venue: PaperVenue;
  specs: VenueSpecs;
  watchdog: NodeJS.Timeout;
}

/**
 * The app's defaults per pair and direction. The percentages are the same for every pair (first order
 * 3% from the base, 1% apart, 3% buyback / re-sell); only the starting amounts differ.
 */
/**
 * Recommended rates per pair and direction: first order from the base, step between orders, and the
 * loop distance (buyback / re-sell, or sell-back / re-buy). Picked from 120 combinations per pair and
 * direction on Bybit 1-minute candles (picked on 19/21 Sep - 12/14 Oct 2026, checked on the following
 * 7 days). Daily reset off: with it on, runs halted once the price trended one way.
 */
export const RECOMMENDED_RATES: Record<SeriesSymbol, Record<SeriesDirection, { first: string; step: string; loop: string }>> = {
  ZIGUSDT: { SELL_FIRST: { first: '1', step: '0.5', loop: '2' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '1.5' } },
  BTCUSDT: { SELL_FIRST: { first: '3', step: '0.25', loop: '1.5' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '3' } },
  ETHUSDT: { SELL_FIRST: { first: '0.5', step: '0.25', loop: '3' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '1.5' } },
  SOLUSDT: { SELL_FIRST: { first: '0.5', step: '0.25', loop: '1.5' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '3' } },
  UNIUSDT: { SELL_FIRST: { first: '2', step: '0.25', loop: '3' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '3' } },
  ONDOUSDT: { SELL_FIRST: { first: '3', step: '1', loop: '3' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '3' } },
  CAKEUSDT: { SELL_FIRST: { first: '0.5', step: '0.25', loop: '3' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '3' } },
  TAOUSDT: { SELL_FIRST: { first: '3', step: '0.5', loop: '1.5' }, BUY_FIRST: { first: '0.5', step: '0.25', loop: '3' } },
};

export function appDefaults(symbol: SeriesSymbol = 'ZIGUSDT', direction: SeriesDirection = 'SELL_FIRST', venue: SeriesVenue = 'BYBIT'): SeriesSettings {
  const amounts: Record<SeriesSymbol, { base: string; usdt: string }> = {
    ZIGUSDT: { base: '15000', usdt: '900' },
    BTCUSDT: { base: '0.1', usdt: '8000' },
    // About 900 USDT worth each, like 15,000 ZIG.
    ETHUSDT: { base: '0.36', usdt: '900' },
    SOLUSDT: { base: '8.3', usdt: '900' },
    UNIUSDT: { base: '118', usdt: '900' },
    ONDOUSDT: { base: '1930', usdt: '900' },
    CAKEUSDT: { base: '400', usdt: '900' },
    TAOUSDT: { base: '3.2', usdt: '900' },
  };
  const a = amounts[symbol];
  const r = RECOMMENDED_RATES[symbol][direction];
  return {
    ...defaultSeriesSettings(), symbol, venue, direction, sellPct: '100', dailyReset: true,
    firstSellPct: r.first, stepPct: r.step, buybackPct: r.loop, resellPct: r.loop,
    totalZig: direction === 'BUY_FIRST' ? '0' : a.base,
    startUsdt: direction === 'BUY_FIRST' ? a.usdt : '0',
  };
}

/** Kept for callers from before pairs existed. */
export const appSeriesDefaults = () => appDefaults('ZIGUSDT', 'SELL_FIRST');
export const appBuyFirstDefaults = () => appDefaults('ZIGUSDT', 'BUY_FIRST');

/**
 * Series paper runs: the exact series engine on live Bybit prices, with simulated fills and balances.
 * A user can run several at once (up to MAX_RUNNING_PER_USER), on Bybit or MEXC pairs, each with its
 * own paper wallet, orders and lock. A user only ever sees and controls their own. A series still
 * running when the backend stops is resumed when it starts again.
 */
@Injectable()
export class SeriesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SeriesService.name);
  /** Running simulations by run id. */
  private readonly live = new Map<string, Live>();
  private readonly starting = new Map<string, number>();
  private readonly resetting = new Set<string>();
  private readonly priceCache = new Map<string, { at: number; price: string | null }>();
  readonly store: PgSeriesStore;
  private readonly holder = `app:${hostname()}`;

  constructor(private readonly api: EngineApiService) {
    this.store = new PgSeriesStore(api.pool);
  }

  private engineLog(tag: string): EngineLogger {
    return {
      info: (m) => this.logger.log(`[${tag}] ${m}`),
      warn: (m) => this.logger.warn(`[${tag}] ${m}`),
      error: (m) => this.logger.error(`[${tag}] ${m}`),
    };
  }
  private quietAlerts(tag: string): Alerter {
    return { send: async (t) => this.logger.log(`[${tag}] ${t.replace(/\n/g, ' | ')}`) };
  }

  private leaseScope(userId: string, runId: string) {
    return `${userId}/series-paper/${runId}`;
  }

  private runningFor(userId: string, venue: SeriesVenue) {
    return [...this.live.values()].filter((l) => l.ownerId === userId && venueOf(l.run.settings) === venue);
  }

  /** Last prices of every pair on every exchange ("BYBIT:ZIGUSDT"), cached for a few seconds (the dashboard polls). */
  private async marketPrices(): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const keys = (Object.keys(VENUE_PAIRS) as SeriesVenue[]).flatMap((v) => VENUE_PAIRS[v].map((sym) => [v, sym] as const));
    await Promise.all(keys.map(async ([v, sym]) => {
      const key = `${v}:${sym}`;
      const hit = this.priceCache.get(key);
      if (hit && Date.now() - hit.at < 3000) { out[key] = hit.price; return; }
      let price: string | null = null;
      try { price = (await marketLastPrice(v, sym)).toFixed(); } catch { /* market price is optional here */ }
      this.priceCache.set(key, { at: Date.now(), price });
      out[key] = price;
    }));
    return out;
  }

  // ── Read model ───────────────────────────────────────────────────────────────────────────────

  /** Every simulation of the user (running ones first), with the numbers a tab or a history row needs. */
  async overview(userId: string) {
    const [rows, markets] = await Promise.all([this.store.runSummaries(userId, 'paper', 50), this.marketPrices()]);
    const runs = rows.map((h) => {
      const l = this.live.get(h.run.id);
      const snap = l?.engine.snapshot();
      return {
        id: h.run.id, label: seriesLabel(h.run.seriesNo), seriesNo: h.run.seriesNo,
        symbol: symbolOf(h.run.settings), venue: venueOf(h.run.settings), asset: assetOf(h.run.settings), direction: directionOf(h.run.settings),
        basePrice: h.run.basePrice.toFixed(), qty: h.run.qty.toFixed(), orders: h.run.settings.orders, totalZig: h.run.settings.totalZig,
        startUsdt: h.run.settings.startUsdt, dailyReset: true,
        startedAt: new Date(h.run.startedAt).toISOString(), stoppedAt: h.run.stoppedAt ? new Date(h.run.stoppedAt).toISOString() : null,
        // RUNNING in the database but not in memory means it is being resumed after a restart.
        status: l ? snap!.status : h.run.status === 'RUNNING' ? 'STARTING' : 'STOPPED',
        statusReason: l ? snap!.statusReason ?? null : h.run.statusReason,
        live: !!l, openOrders: snap?.liveOrders ?? 0,
        cycles: h.cycles, profit: h.profit.toFixed(4),
      };
    });
    // Per exchange: its pairs, default settings, and its own running count, limit and profit.
    const venues = (Object.keys(VENUE_PAIRS) as SeriesVenue[]).map((venue) => {
      const mine = runs.filter((r) => r.venue === venue);
      const running = mine.filter((r) => r.status !== 'STOPPED');
      const defaults: Record<string, Record<string, SeriesSettings>> = {};
      for (const symbol of VENUE_PAIRS[venue]) {
        defaults[symbol] = { SELL_FIRST: appDefaults(symbol, 'SELL_FIRST', venue), BUY_FIRST: appDefaults(symbol, 'BUY_FIRST', venue) };
      }
      return {
        venue, running: running.length, maxRunning: MAX_RUNNING_PER_USER,
        totalProfit: mine.reduce((n, r) => n.plus(r.profit), ZERO).toFixed(4),
        runningProfit: running.reduce((n, r) => n.plus(r.profit), ZERO).toFixed(4),
        pairs: VENUE_PAIRS[venue].map((symbol) => ({ symbol, asset: SERIES_PAIRS[symbol].asset })),
        defaults,
      };
    });
    return { runs, venues, markets };
  }

  /** One of the user's simulations in full. Another user's id is reported as not found. */
  async detail(userId: string, runId: string) {
    const live = this.live.get(runId);
    const run = live?.run ?? (await this.store.getRun(runId).catch(() => null));
    if (!run || run.ownerId !== userId) throw new NotFoundException('No such simulation');
    return this.describe(run, live);
  }

  /** Everything the dashboard shows about one series: its orders, fills, loops and totals. */
  private async describe(run: SeriesRun, live?: Live) {
    const [slots, cycles, recent, counts, events] = await Promise.all([
      live ? Promise.resolve(live.engine.getSlots()) : this.store.loadSlots(run.id),
      live ? Promise.resolve(live.engine.getCycles()) : this.store.listCycles(run.id),
      this.store.recentFills(run.id, 300),
      this.store.countFills(run.id),
      this.store.listEvents(run.id, 40),
    ]);
    const snap = live?.engine.snapshot();
    const balances = live ? await live.venue.getBalances() : null;
    const profit = cycles.reduce((n, c) => n.plus(c.profit), ZERO);
    const direction = directionOf(run.settings);
    const closingSide = direction === 'BUY_FIRST' ? 'SELL' : 'BUY';
    const cycleKey = new Map(cycles.map((c) => [`${c.slot}:${c.cycle}`, c]));
    const fills = recent.map((f) => {
      const id = parseSeriesOrderId(f.clientOrderId);
      const kind = orderKind(direction, f.side, id?.cycle ?? 1);
      const closed = f.side === closingSide && id ? cycleKey.get(`${id.slot}:${id.cycle}`) : undefined;
      return {
        id: f.fillId, ts: new Date(f.ts).toISOString(), slot: id?.slot ?? 0, cycle: id?.cycle ?? 0, side: f.side, kind,
        price: f.price.toFixed(), qty: f.qty.toFixed(), value: f.price.mul(f.qty).toFixed(4),
        fee: f.feeAmount.toFixed(), feeAsset: f.feeAsset,
        loopProfit: closed && closed.closedAt === f.ts ? closed.profit.toFixed(4) : null,
      };
    });
    const orders = slots.map((s: Slot) => {
      const side = s.state === 'SELL_LIVE' ? 'SELL' : 'BUY';
      const target = side === 'SELL' ? s.sellTarget : s.buyTarget;
      const done = cycles.filter((c) => c.slot === s.slot);
      return {
        slot: s.slot, cycle: s.cycle, side,
        kind: orderKind(direction, side, s.cycle),
        target: target?.toFixed() ?? null,
        price: s.order?.price.toFixed() ?? null,
        qty: s.legQty.toFixed(), filled: s.legFilled.toFixed(),
        status: s.order ? (s.order.status === 'LIVE' ? 'OPEN' : 'SENDING') : (s.waiting ? 'WAITING' : (live ? 'QUEUED' : 'CANCELLED')),
        waiting: s.waiting ?? null,
        soldAt: s.soldQty.gt(0) ? s.soldQuote.plus(s.feeSellQuote).div(s.soldQty).toFixed(6) : null,
        boughtAt: s.boughtGross.gt(0) ? s.buyCost.minus(s.feeBuyQuote).div(s.boughtGross).toFixed(6) : null,
        zigOut: owed(s).toFixed(), loops: done.length, loopProfit: done.reduce((n, c) => n.plus(c.profit), ZERO).toFixed(4),
      };
    });
    const zigOut = slots.reduce((n: Decimal, s: Slot) => n.plus(owed(s)), ZERO);
    const reserve = slots.reduce((n: Decimal, s: Slot) => n.plus(reserveOf(s)), ZERO);
    const started = run.startedAt;
    const ended = run.stoppedAt ?? Date.now();
    const hours = Math.max((ended - started) / 3_600_000, 1 / 60);
    const s = run.settings;
    return {
      id: run.id, label: seriesLabel(run.seriesNo), seriesNo: run.seriesNo, direction,
      symbol: symbolOf(s), venue: venueOf(s), asset: assetOf(s),
      status: live ? snap!.status : run.status === 'RUNNING' ? 'STARTING' : 'STOPPED',
      statusReason: live ? snap!.statusReason ?? null : run.statusReason,
      running: !!live,
      startedAt: new Date(started).toISOString(), stoppedAt: run.stoppedAt ? new Date(run.stoppedAt).toISOString() : null,
      // Every simulation resets daily (series started before that rule have their first reset at the next midnight).
      dailyReset: {
        resets: run.resets ?? 0,
        lastAt: run.lastResetAt ? new Date(run.lastResetAt).toISOString() : null,
        nextAt: live ? new Date(lastResetBoundary(Date.now()) + DAY_MS).toISOString() : null,
        // What loops closed early by resets left behind: base sold and not bought back (positive) or bought and not sold back (negative).
        zigLeftOpen: (run.carriedBase ?? ZERO).neg().toFixed(),
        usdtLeftOpen: (run.carriedQuote ?? ZERO).toFixed(4),
      },
      settings: s,
      plan: {
        basePrice: run.basePrice.toFixed(), qty: run.qty.toFixed(), orders: s.orders,
        firstSell: (() => {
          // The first opening order's price while slot 1 is still on its first loop.
          const one = slots.find((x) => x.slot === 1);
          if (!one || one.cycle !== 1) return null;
          return direction === 'BUY_FIRST' ? one.buyTarget?.toFixed() ?? null : one.sellTarget.toFixed();
        })(),
      },
      book: snap?.book ?? null,
      totals: {
        profit: profit.toFixed(4),
        profitPerHour: profit.div(hours).toFixed(4),
        cycles: cycles.length,
        sellFills: counts.sells, buyFills: counts.buys,
        openSells: orders.filter((o) => o.side === 'SELL' && o.status === 'OPEN').length,
        openBuys: orders.filter((o) => o.side === 'BUY' && o.status === 'OPEN').length,
        zigOut: zigOut.toFixed(), usdtHeldForBuybacks: reserve.toFixed(4),
        fees: cycles.reduce((n, c) => n.plus(c.feeSellQuote).plus(c.feeBuyQuote).plus(c.boughtGross.minus(c.boughtNet).mul(c.avgBuy)), ZERO).toFixed(4),
      },
      balances: balances ? { zig: balances.base.toFixed(), usdt: balances.quote.toFixed(4) } : null,
      orders,
      fills,
      loops: [...cycles].reverse().slice(0, 200).map((c: SeriesCycle) => ({
        slot: c.slot, cycle: c.cycle, qty: c.soldQty.toFixed(), sold: c.avgSell.toFixed(6), bought: c.avgBuy.toFixed(6),
        profit: c.profit.toFixed(4), openedAt: new Date(c.openedAt).toISOString(), closedAt: new Date(c.closedAt).toISOString(),
      })),
      events: events.map((e) => ({ ts: new Date(e.ts).toISOString(), kind: e.kind, detail: e.detail })),
      breaches: snap?.breaches ?? [],
    };
  }

  // ── Plan, start, stop ────────────────────────────────────────────────────────────────────────

  private async market(venue: SeriesVenue, symbol: SeriesSymbol) {
    const [specs, price] = await Promise.all([marketSpecs(venue, symbol), marketLastPrice(venue, symbol)]);
    return { specs, price };
  }

  private plan(settings: SeriesSettings, price: Decimal, specs: VenueSpecs) {
    try {
      return buildPlan(settings, price, specs);
    } catch (e) {
      if (e instanceof SeriesSettingsError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  async preview(settings: SeriesSettings) {
    const venue = venueOf(settings);
    if (!isSeriesVenue(venue)) throw new BadRequestException('Exchange must be Bybit or MEXC');
    if (!VENUE_PAIRS[venue].includes(symbolOf(settings))) throw new BadRequestException(`${symbolOf(settings)} is not listed on ${venue === 'MEXC' ? 'MEXC' : 'Bybit'}`);
    const { specs, price } = await this.market(venue, symbolOf(settings));
    const plan = this.plan(settings, price, specs);
    const buyFirst = plan.direction === 'BUY_FIRST';
    const one = new Decimal(1);
    const fee = specs.makerFee;
    const buybackPct = new Decimal(settings.buybackPct);
    const resellPct = new Decimal(settings.resellPct);
    // Where each order's loop closes: a buyback below a sell, or a sell-back above a buy.
    const closeAt = (p: Decimal) => (buyFirst ? resellPrice(p, resellPct, specs.tick) : buybackPrice(p, buybackPct, specs.tick));
    // One loop on the first order, fees on both legs (Bybit takes the buy fee in the base asset).
    const first = plan.orders[0].price;
    const loopProfit = buyFirst
      ? roundDown(plan.qty.mul(one.minus(fee)), specs.lot).mul(closeAt(first)).mul(one.minus(fee)).minus(plan.qty.mul(first))
      : plan.qty.mul(first).mul(one.minus(fee)).minus(plan.qty.div(one.minus(fee)).mul(closeAt(first)));
    return {
      symbol: symbolOf(settings), venue, asset: assetOf(settings),
      makerFeePct: specs.makerFee.mul(100).toFixed(),
      direction: plan.direction,
      marketPrice: price.toFixed(),
      basePrice: plan.basePrice.toFixed(),
      qtyPerOrder: plan.qty.toFixed(),
      zigForSale: plan.zigForSale.toFixed(),
      usdtForBuys: plan.usdtForBuys.toFixed(2),
      orders: plan.orders.map((o) => ({
        slot: o.slot, side: o.side, price: o.price.toFixed(), value: o.price.mul(plan.qty).toFixed(2),
        // A sell never rests below its price, a buy never above it; past the market they rest at the market.
        restsAt: (buyFirst ? Decimal.min(o.price, price) : Decimal.max(o.price, price)).toFixed(),
        nextAt: closeAt(o.price).toFixed(),
      })),
      // Orders the market still has to reach: sells above it, or buys below it.
      waitingForMarket: plan.orders.filter((o) => (buyFirst ? o.price.lt(price) : o.price.gt(price))).length,
      loopProfit: loopProfit.toFixed(4),
      nextPct: (buyFirst ? buybackPct : resellPct).toFixed(),
      minOrderValue: specs.minOrderValue.toFixed(),
    };
  }

  private async launch(userId: string, tag: string, run: SeriesRun, specs: VenueSpecs, price: Decimal,
    balances: { zig: Decimal; usdt: Decimal }, resume?: { slots: Slot[]; cycles: SeriesCycle[] }) {
    const symbol = symbolOf(run.settings);
    const feed = venueOf(run.settings);
    const plan = buildPlan(run.settings, price, specs);
    // The plan's base and size are fixed when the series starts; a resume keeps them.
    const fixedPlan = { ...plan, basePrice: run.basePrice, qty: run.qty };
    const log = this.engineLog(tag);
    // Each simulation has its own paper wallet: its own venue, balances and orders.
    const venue = new PaperVenue({
      symbol, specs, clock: systemClock, log, startPrice: price, feed,
      startBase: balances.zig, startQuote: balances.usdt, idPrefix: `p${Date.now().toString(36)}${run.seriesNo}`,
    });
    const engine = new SeriesEngine({
      run, plan: fixedPlan, specs, venue, store: this.store, lease: new PgLease(this.api.pool),
      leaseScope: this.leaseScope(userId, run.id), holder: this.holder, clock: systemClock, log, alert: this.quietAlerts(tag),
      symbol, feedStaleSeconds: 60, leaseTtlSeconds: LEASE_TTL_SECONDS, recheckDelayMs: 0,
    });
    const runner = new SeriesRunner(engine, venue, log);
    await runner.start(resume);
    const status = engine.getStatus();
    if (status === 'STOPPED' || status === 'HALTED') {
      throw new ConflictException(status === 'STOPPED' ? 'Another instance is running this simulation.' : `The series halted at start: ${engine.snapshot().statusReason}`);
    }
    const s = run.settings;
    // Daily reset is always on. A series started before that (its settings say off) is not reset
    // for days it already ran: its first reset is the next midnight after this launch.
    const resetFrom = s.dailyReset ? run.startedAt : Date.now();
    const watchdog = setInterval(() => {
      const snap = engine.snapshot();
      if (snap.status === 'HALTED' || snap.status === 'STOPPED') {
        void this.forget(run.id, engine);
      } else if ((run.lastResetAt ?? resetFrom) < lastResetBoundary(Date.now())) {
        void this.dailyReset(run.id, tag);
      } else if (s.maxCycles !== null && snap.cyclesCompleted >= s.maxCycles) {
        void this.stop(userId, run.id, tag, `reached ${s.maxCycles} completed loops`);
      } else if (s.maxHours !== null && Date.now() - run.startedAt >= s.maxHours * 3_600_000) {
        void this.stop(userId, run.id, tag, `ran for ${s.maxHours} hours`);
      }
    }, 10_000);
    this.live.set(run.id, { ownerId: userId, run, engine, runner, venue, specs, watchdog });
    void runner.done.then(() => this.forget(run.id, engine));
  }

  /**
   * Moves a series to a new base: the close of the Bybit 1-minute candle that ended at the reset
   * moment. Runs once per day; a reset missed while the backend was down runs when it is back.
   */
  private async dailyReset(runId: string, tag: string) {
    const l = this.live.get(runId);
    if (!l || this.resetting.has(runId)) return;
    this.resetting.add(runId);
    try {
      const boundary = lastResetBoundary(Date.now());
      const price = await marketCloseAt(venueOf(l.run.settings), symbolOf(l.run.settings), boundary);
      const summary = await l.engine.rebase(price, Date.now());
      if (summary) this.logger.log(`[${tag}] ${symbolOf(l.run.settings)} series ${seriesLabel(l.run.seriesNo)} daily reset: base ${summary.from} -> ${summary.to}, ${summary.orders} orders, ${summary.loopsClosedEarly} open loops closed`);
    } catch (e) {
      this.logger.error(`[${tag}] daily reset failed, retrying shortly: ${(e as Error).message}`);
    } finally {
      this.resetting.delete(runId);
    }
  }

  /** Drops a series that ended by itself (halted, or lease lost). Its records stay in the database. */
  private async forget(runId: string, engine: SeriesEngine) {
    const l = this.live.get(runId);
    if (!l || l.engine !== engine) return;
    clearInterval(l.watchdog);
    this.live.delete(runId);
    await l.runner.stop(engine.snapshot().statusReason ?? 'ended').catch(() => undefined);
  }

  /** Starts a new simulation next to any already running (up to MAX_RUNNING_PER_USER per exchange). */
  async start(userId: string, email: string, settings: SeriesSettings) {
    const venue = venueOf(settings);
    if (!isSeriesVenue(venue)) throw new BadRequestException('Exchange must be Bybit or MEXC');
    const name = venue === 'MEXC' ? 'MEXC' : 'Bybit';
    const key = `${userId}:${venue}`;
    const busy = (this.starting.get(key) ?? 0);
    if (this.runningFor(userId, venue).length + busy >= MAX_RUNNING_PER_USER) {
      throw new ConflictException(`You can run up to ${MAX_RUNNING_PER_USER} simulations at once on ${name}. Stop one first.`);
    }
    this.starting.set(key, busy + 1);
    try {
      const symbol = symbolOf(settings);
      if (!VENUE_PAIRS[venue].includes(symbol)) throw new BadRequestException(`${symbol} is not listed on ${name}`);
      const { specs, price } = await this.market(venue, symbol);
      const plan = this.plan(settings, price, specs);
      const zig = new Decimal(settings.totalZig);
      const usdt = new Decimal(settings.startUsdt);
      const run = await this.store.createRun({
        ownerId: userId, mode: 'paper', settings: { ...settings, symbol, venue, dailyReset: true }, basePrice: plan.basePrice, qty: plan.qty,
        startZig: zig, startUsdt: usdt, startedAt: Date.now(),
      });
      try {
        await this.launch(userId, email, run, specs, price, { zig, usdt });
      } catch (e) {
        await this.store.stopRun(run.id, `could not start: ${(e as Error).message}`);
        throw e;
      }
      this.logger.log(`[${email}] ${name} ${symbol} series ${seriesLabel(run.seriesNo)} started at base ${plan.basePrice.toFixed()}`);
      return { id: run.id, ...(await this.overview(userId)) };
    } finally {
      const n = (this.starting.get(key) ?? 1) - 1;
      if (n > 0) this.starting.set(key, n); else this.starting.delete(key);
    }
  }

  /**
   * Starts the same simulation on the other exchange: same pair, direction, wallet, order count,
   * percentages and daily reset, and the same base price as the original has now, so the orders sit
   * at the same prices (rounded to that exchange's price step). The copy is independent.
   */
  async copy(userId: string, runId: string, email: string, target: SeriesVenue) {
    const run = this.live.get(runId)?.run ?? (await this.store.getRun(runId).catch(() => null));
    if (!run || run.ownerId !== userId) throw new NotFoundException('No such simulation');
    if (!isSeriesVenue(target)) throw new BadRequestException('Exchange must be Bybit or MEXC');
    if (target === venueOf(run.settings)) throw new BadRequestException('Pick the other exchange to copy to');
    // The original's opening prices as it built them (its base may have moved with the daily reset).
    const source = venueOf(run.settings);
    const sourceSpecs = await marketSpecs(source, symbolOf(run.settings));
    const sourcePlan = buildPlan({ ...run.settings, basePrice: run.basePrice.toFixed() }, run.basePrice, sourceSpecs);
    return this.start(userId, email, {
      ...run.settings, venue: target, basePrice: run.basePrice.toFixed(), ladder: sourcePlan.orders.map((o) => o.price.toFixed()),
    });
  }

  /** Cancels every order of one of the user's simulations and ends it. Profit stays recorded. */
  async stop(userId: string, runId: string, email: string, reason = 'stopped by user') {
    const l = this.live.get(runId);
    if (l) {
      if (l.ownerId !== userId) throw new NotFoundException('No such simulation');
      clearInterval(l.watchdog);
      this.live.delete(runId);
      await l.runner.stop(reason);
      this.logger.log(`[${email}] ${symbolOf(l.run.settings)} series ${seriesLabel(l.run.seriesNo)} stopped: ${reason}`);
    } else {
      // Nothing in memory (it halted, or is still being resumed): make sure the record is closed too.
      const run = await this.store.getRun(runId).catch(() => null);
      if (!run || run.ownerId !== userId) throw new NotFoundException('No such simulation');
      if (run.status === 'RUNNING') await this.store.stopRun(run.id, reason);
    }
    return this.overview(userId);
  }

  // ── Restart safety ───────────────────────────────────────────────────────────────────────────

  /** Resumes every series that was running when the backend stopped, from its stored state. */
  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;
    let runs: SeriesRun[];
    try {
      runs = await this.store.runningRuns('paper');
    } catch (e) {
      this.logger.error(`could not list running series: ${(e as Error).message}`);
      return;
    }
    for (const run of runs) void this.resume(run, 0);
  }

  private async resume(run: SeriesRun, attempt: number): Promise<void> {
    const tag = `${run.ownerId.slice(0, 8)}`;
    if (this.live.has(run.id)) return;
    // Stopped by the user while waiting to resume: nothing to do.
    const current = await this.store.getRun(run.id).catch(() => null);
    if (current && current.status !== 'RUNNING') return;
    // Wait until the previous process's lease has expired, so the start below does not lose the race.
    const lease = (await this.api.pool.query(
      'SELECT holder, expires_at > now() AS held FROM engine_leases WHERE pair_id = ANY($1)',
      [[this.leaseScope(run.ownerId, run.id), `${run.ownerId}/series-paper`]],
    ).catch(() => ({ rows: [] as any[] }))).rows.find((r: any) => r.held && r.holder !== this.holder);
    if (lease) {
      setTimeout(() => void this.resume(run, attempt), (LEASE_TTL_SECONDS + 2) * 1000).unref();
      return;
    }
    try {
      const [{ specs, price }, slots, cycles] = await Promise.all([
        this.market(venueOf(run.settings), symbolOf(run.settings)), this.store.loadSlots(run.id), this.store.listCycles(run.id),
      ]);
      // Rebuild the simulated wallet from the records: what was sold and not bought back is USDT.
      const residual = cycles.reduce((n, c) => n.plus(c.boughtNet).minus(c.soldQty), ZERO);
      const zig = run.startZig.plus(residual).plus(run.carriedBase ?? ZERO).minus(slots.reduce((n, s) => n.plus(owed(s)), ZERO));
      const usdt = run.startUsdt.plus(run.carriedQuote ?? ZERO).plus(slots.reduce((n, s) => n.plus(reserveOf(s)), ZERO)).plus(cycles.reduce((n, c) => n.plus(c.profit), ZERO));
      await this.launch(run.ownerId, tag, run, specs, price, { zig, usdt }, { slots, cycles });
      this.logger.log(`[${tag}] resumed ${symbolOf(run.settings)} series ${seriesLabel(run.seriesNo)} (${cycles.length} loops so far)`);
    } catch (e) {
      // The previous process's lease may still be live for a few seconds: try again shortly.
      if (attempt < 6) {
        setTimeout(() => void this.resume(run, attempt + 1), (LEASE_TTL_SECONDS + 5) * 1000).unref();
      } else {
        this.logger.error(`[${tag}] could not resume series ${seriesLabel(run.seriesNo)}: ${(e as Error).message}`);
        await this.store.stopRun(run.id, `could not resume after restart: ${(e as Error).message}`).catch(() => undefined);
      }
    }
  }

  /**
   * On shutdown the timers stop but the series stay RUNNING in the database, so the next start
   * resumes them. Paper orders only exist in this process, so there is nothing to cancel elsewhere.
   */
  async onModuleDestroy() {
    for (const l of this.live.values()) {
      clearInterval(l.watchdog);
      await l.runner.detach().catch(() => undefined);
    }
    this.live.clear();
  }
}
