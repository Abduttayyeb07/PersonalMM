import { BadRequestException, ConflictException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import Decimal from 'decimal.js';
import { hostname } from 'os';
import { PgLease } from '../engine/supervisor/lease';
import { Alerter, Logger as EngineLogger, VenueSpecs, systemClock } from '../engine/types';
import { bybitCloseAt, bybitLastPrice, bybitPublicSpecs } from '../engine/venue/bybit-public';
import { PaperVenue } from '../engine/venue/paper-venue';
import { owed, reserveOf } from '../series/accounting';
import { SeriesEngine } from '../series/engine';
import { parseSeriesOrderId } from '../series/order-id';
import { PgSeriesStore } from '../series/pg-store';
import { roundDown } from '../engine/lattice';
import { SeriesSettingsError, buildPlan, buybackPrice, defaultSeriesSettings, resellPrice } from '../series/plan';
import { SeriesRunner } from '../series/runner';
import { SeriesCycle, SeriesRun, SeriesSettings, Slot, directionOf, orderKind, seriesLabel } from '../series/types';
import { EngineApiService } from './engine-api.service';

const SYMBOL = 'ZIGUSDT';
const ZERO = new Decimal(0);
const LEASE_TTL_SECONDS = 30;
const DAY_MS = 86_400_000;
/** Daily reset time: 00:00 in Pakistan (UTC+5, no daylight saving) is 19:00 UTC. */
const RESET_UTC_OFFSET_MS = 19 * 3_600_000;

/** The most recent daily reset moment at or before `now`. */
export function lastResetBoundary(now: number): number {
  return Math.floor((now - RESET_UTC_OFFSET_MS) / DAY_MS) * DAY_MS + RESET_UTC_OFFSET_MS;
}

interface Live {
  run: SeriesRun;
  engine: SeriesEngine;
  runner: SeriesRunner;
  venue: PaperVenue;
  specs: VenueSpecs;
  watchdog: NodeJS.Timeout;
}

/** The app's defaults: all of 15,000 ZIG for sale in 15 sells, first at base +3%, 1% apart, -3% / +3%. */
export function appSeriesDefaults(): SeriesSettings {
  return { ...defaultSeriesSettings(), sellPct: '100', dailyReset: true };
}

/** Default buy-first settings: about the same capital as 15,000 ZIG, held as USDT. */
export function appBuyFirstDefaults(): SeriesSettings {
  return { ...appSeriesDefaults(), direction: 'BUY_FIRST', totalZig: '0', startUsdt: '900' };
}

/**
 * Series paper runs: the exact series engine on live Bybit prices, with simulated fills and balances.
 * Each user has at most one running series; their runs, orders and fills are theirs alone. A series
 * still running when the backend stops is resumed when it starts again.
 */
@Injectable()
export class SeriesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SeriesService.name);
  private readonly live = new Map<string, Live>();
  private readonly busy = new Set<string>();
  private readonly resetting = new Set<string>();
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

  // ── Read model ───────────────────────────────────────────────────────────────────────────────

  async overview(userId: string) {
    const live = this.live.get(userId);
    const latest = live?.run ?? (await this.store.latestRun(userId, 'paper'));
    let market: string | null = null;
    try { market = (await bybitLastPrice(SYMBOL)).toFixed(); } catch { /* market price is optional here */ }
    const history = (await this.store.runSummaries(userId, 'paper', 30)).map((h) => ({
      id: h.run.id, label: seriesLabel(h.run.seriesNo), seriesNo: h.run.seriesNo, direction: directionOf(h.run.settings), basePrice: h.run.basePrice.toFixed(),
      qty: h.run.qty.toFixed(), orders: h.run.settings.orders, totalZig: h.run.settings.totalZig,
      startedAt: new Date(h.run.startedAt).toISOString(), stoppedAt: h.run.stoppedAt ? new Date(h.run.stoppedAt).toISOString() : null,
      status: h.run.status, statusReason: h.run.statusReason, cycles: h.cycles, profit: h.profit.toFixed(4),
    }));
    const base = { defaults: appSeriesDefaults(), buyFirstDefaults: appBuyFirstDefaults(), marketPrice: market, history };
    if (!latest) return { ...base, running: false, series: null };
    return { ...base, running: !!live, series: await this.describe(latest, live) };
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
      status: live ? snap!.status : 'STOPPED', statusReason: live ? snap!.statusReason ?? null : run.statusReason,
      startedAt: new Date(started).toISOString(), stoppedAt: run.stoppedAt ? new Date(run.stoppedAt).toISOString() : null,
      dailyReset: s.dailyReset ? {
        resets: run.resets ?? 0,
        lastAt: run.lastResetAt ? new Date(run.lastResetAt).toISOString() : null,
        nextAt: live ? new Date(lastResetBoundary(Date.now()) + DAY_MS).toISOString() : null,
        // What loops closed early by resets left behind: ZIG sold and not bought back (positive) or bought and not sold back (negative).
        zigLeftOpen: (run.carriedBase ?? ZERO).neg().toFixed(),
        usdtLeftOpen: (run.carriedQuote ?? ZERO).toFixed(4),
      } : null,
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

  private async market() {
    const [specs, price] = await Promise.all([bybitPublicSpecs(SYMBOL), bybitLastPrice(SYMBOL)]);
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
    const { specs, price } = await this.market();
    const plan = this.plan(settings, price, specs);
    const buyFirst = plan.direction === 'BUY_FIRST';
    const one = new Decimal(1);
    const fee = specs.makerFee;
    const buybackPct = new Decimal(settings.buybackPct);
    const resellPct = new Decimal(settings.resellPct);
    // Where each order's loop closes: a buyback below a sell, or a sell-back above a buy.
    const closeAt = (p: Decimal) => (buyFirst ? resellPrice(p, resellPct, specs.tick) : buybackPrice(p, buybackPct, specs.tick));
    // One loop on the first order, fees on both legs (Bybit takes the buy fee in ZIG).
    const first = plan.orders[0].price;
    const loopProfit = buyFirst
      ? roundDown(plan.qty.mul(one.minus(fee)), specs.lot).mul(closeAt(first)).mul(one.minus(fee)).minus(plan.qty.mul(first))
      : plan.qty.mul(first).mul(one.minus(fee)).minus(plan.qty.div(one.minus(fee)).mul(closeAt(first)));
    return {
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
    const plan = buildPlan(run.settings, price, specs);
    // The plan's base and size are fixed when the series starts; a resume keeps them.
    const fixedPlan = { ...plan, basePrice: run.basePrice, qty: run.qty };
    const log = this.engineLog(tag);
    const venue = new PaperVenue({
      symbol: SYMBOL, specs, clock: systemClock, log, startPrice: price,
      startBase: balances.zig, startQuote: balances.usdt, idPrefix: `p${Date.now().toString(36)}`,
    });
    const engine = new SeriesEngine({
      run, plan: fixedPlan, specs, venue, store: this.store, lease: new PgLease(this.api.pool),
      leaseScope: `${userId}/series-paper`, holder: this.holder, clock: systemClock, log, alert: this.quietAlerts(tag),
      symbol: SYMBOL, feedStaleSeconds: 60, leaseTtlSeconds: LEASE_TTL_SECONDS, recheckDelayMs: 0,
    });
    const runner = new SeriesRunner(engine, venue, log);
    await runner.start(resume);
    const status = engine.getStatus();
    if (status === 'STOPPED' || status === 'HALTED') {
      throw new ConflictException(status === 'STOPPED' ? 'Another instance is running a series for this account.' : `The series halted at start: ${engine.snapshot().statusReason}`);
    }
    const s = run.settings;
    const watchdog = setInterval(() => {
      const snap = engine.snapshot();
      if (snap.status === 'HALTED' || snap.status === 'STOPPED') {
        void this.forget(userId, engine);
      } else if (s.dailyReset && (run.lastResetAt ?? run.startedAt) < lastResetBoundary(Date.now())) {
        void this.dailyReset(userId, tag);
      } else if (s.maxCycles !== null && snap.cyclesCompleted >= s.maxCycles) {
        void this.stop(userId, tag, `reached ${s.maxCycles} completed loops`);
      } else if (s.maxHours !== null && Date.now() - run.startedAt >= s.maxHours * 3_600_000) {
        void this.stop(userId, tag, `ran for ${s.maxHours} hours`);
      }
    }, 10_000);
    this.live.set(userId, { run, engine, runner, venue, specs, watchdog });
    void runner.done.then(() => this.forget(userId, engine));
  }

  /**
   * Moves the user's series to a new base: the close of the Bybit 1-minute candle that ended at the
   * reset moment. Runs once per day; a reset missed while the backend was down runs when it is back.
   */
  private async dailyReset(userId: string, tag: string) {
    const l = this.live.get(userId);
    if (!l || this.resetting.has(userId)) return;
    this.resetting.add(userId);
    try {
      const boundary = lastResetBoundary(Date.now());
      const price = await bybitCloseAt(SYMBOL, boundary);
      const summary = await l.engine.rebase(price, Date.now());
      if (summary) this.logger.log(`[${tag}] daily reset: base ${summary.from} -> ${summary.to}, ${summary.orders} orders, ${summary.loopsClosedEarly} open loops closed`);
    } catch (e) {
      this.logger.error(`[${tag}] daily reset failed, retrying shortly: ${(e as Error).message}`);
    } finally {
      this.resetting.delete(userId);
    }
  }

  /** Drops a series that ended by itself (halted, or lease lost). Its records stay in the database. */
  private async forget(userId: string, engine: SeriesEngine) {
    const l = this.live.get(userId);
    if (!l || l.engine !== engine) return;
    clearInterval(l.watchdog);
    this.live.delete(userId);
    await l.runner.stop(engine.snapshot().statusReason ?? 'ended').catch(() => undefined);
  }

  async start(userId: string, email: string, settings: SeriesSettings) {
    if (this.live.has(userId) || this.busy.has(userId)) throw new ConflictException('A series is already running. Stop it first.');
    this.busy.add(userId);
    try {
      const { specs, price } = await this.market();
      const plan = this.plan(settings, price, specs);
      const zig = new Decimal(settings.totalZig);
      const usdt = new Decimal(settings.startUsdt);
      const run = await this.store.createRun({
        ownerId: userId, mode: 'paper', settings, basePrice: plan.basePrice, qty: plan.qty, startZig: zig, startUsdt: usdt, startedAt: Date.now(),
      });
      try {
        await this.launch(userId, email, run, specs, price, { zig, usdt });
      } catch (e) {
        await this.store.stopRun(run.id, `could not start: ${(e as Error).message}`);
        throw e;
      }
      this.logger.log(`[${email}] series ${seriesLabel(run.seriesNo)} started at base ${plan.basePrice.toFixed()}`);
      return this.overview(userId);
    } finally {
      this.busy.delete(userId);
    }
  }

  /** Cancels every order of the user's series and ends it. Profit stays recorded. */
  async stop(userId: string, email: string, reason = 'stopped by user') {
    const l = this.live.get(userId);
    if (l) {
      clearInterval(l.watchdog);
      this.live.delete(userId);
      await l.runner.stop(reason);
      this.logger.log(`[${email}] series ${seriesLabel(l.run.seriesNo)} stopped: ${reason}`);
    } else {
      // Nothing in memory (e.g. it halted): make sure the record is closed too.
      const latest = await this.store.latestRun(userId, 'paper');
      if (latest?.status === 'RUNNING') await this.store.stopRun(latest.id, reason);
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
    if (this.live.has(run.ownerId)) return;
    // Wait until the previous process's lease has expired, so the start below does not lose the race.
    const lease = (await this.api.pool.query(
      'SELECT holder, expires_at > now() AS held FROM engine_leases WHERE pair_id=$1', [`${run.ownerId}/series-paper`],
    ).catch(() => ({ rows: [] as any[] }))).rows[0];
    if (lease?.held && lease.holder !== this.holder) {
      setTimeout(() => void this.resume(run, attempt), (LEASE_TTL_SECONDS + 2) * 1000).unref();
      return;
    }
    try {
      const [{ specs, price }, slots, cycles] = await Promise.all([this.market(), this.store.loadSlots(run.id), this.store.listCycles(run.id)]);
      // Rebuild the simulated balances from the records: what was sold and not bought back is USDT.
      const residual = cycles.reduce((n, c) => n.plus(c.boughtNet).minus(c.soldQty), ZERO);
      const zig = run.startZig.plus(residual).plus(run.carriedBase ?? ZERO).minus(slots.reduce((n, s) => n.plus(owed(s)), ZERO));
      const usdt = run.startUsdt.plus(run.carriedQuote ?? ZERO).plus(slots.reduce((n, s) => n.plus(reserveOf(s)), ZERO)).plus(cycles.reduce((n, c) => n.plus(c.profit), ZERO));
      await this.launch(run.ownerId, tag, run, specs, price, { zig, usdt }, { slots, cycles });
      this.logger.log(`[${tag}] resumed series ${seriesLabel(run.seriesNo)} (${cycles.length} loops so far)`);
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
   * On shutdown the timers stop but the series stays RUNNING in the database, so the next start
   * resumes it. Paper orders only exist in this process, so there is nothing to cancel elsewhere.
   */
  async onModuleDestroy() {
    for (const l of this.live.values()) {
      clearInterval(l.watchdog);
      await l.runner.detach().catch(() => undefined);
    }
    this.live.clear();
  }
}
