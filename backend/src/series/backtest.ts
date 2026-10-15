import Decimal from 'decimal.js';
import { Candle } from '../engine/backtest/candles';
import { MemoryLease } from '../engine/supervisor/lease';
import { CapturingAlerter, FakeClock } from '../engine/testing';
import { Alerter, VenueSpecs, silentLogger } from '../engine/types';
import { SimVenue } from '../engine/venue/sim-venue';
import { owed } from './accounting';
import { parseSeriesOrderId } from './order-id';
import { SeriesEngine } from './engine';
import { MemorySeriesStore } from './memory-store';
import { buildPlan } from './plan';
import { OrderKind, SeriesDirection, SeriesSettings, directionOf, orderKind } from './types';

export interface SeriesBacktestReport {
  label: string;
  from: string;
  to: string;
  days: number;
  candles: number;
  startPrice: string;
  endPrice: string;
  lowPrice: string;
  highPrice: string;
  basePrice: string;
  firstSell: string;
  lastSell: string;
  qtyPerOrder: string;
  /** Orders the engine sent and the venue accepted (first sells, buybacks, re-sells, re-pricings). */
  ordersPlaced: number;
  ordersRejected: number;
  sellFills: number;
  buyFills: number;
  /** Sell legs that filled completely (each one created a buyback). */
  sellsCompleted: number;
  cyclesCompleted: number;
  cyclesPerDay: number;
  realisedProfitUsd: string;
  feesPaidUsd: string;
  /** ZIG sold whose buyback had not filled when the run ended. */
  zigStillSold: string;
  maxZigSold: string;
  /** USDT held back behind the open buybacks at the end. */
  reserveEndUsd: string;
  openSellsEnd: number;
  openBuysEnd: number;
  /** Account value change at the final price (ZIG + USDT), vs simply holding the ZIG. */
  markToMarketUsd: string;
  holdUsd: string;
  status: string;
  statusReason?: string;
  cyclesBySlot: Record<string, number>;
  /** Orders accepted by the venue, by what they were for. */
  direction: SeriesDirection;
  /**
   * Orders by role. Selling first: first sells / buybacks / re-sells. Buying first, the same three
   * buckets hold first buys / sell-backs / re-buys.
   */
  placedByKind: { firstSells: number; buybacks: number; resells: number };
  /** Fills by what the order was for. */
  filledByKind: { firstSells: number; buybacks: number; resells: number };
  /** One row per order slot: its starting sell and what it went on to do. */
  slots: Array<{ slot: number; firstSell: string; cycles: number; profit: string; state: string; cycle: number; livePrice: string | null; owedZig: string }>;
  /** Every fill, oldest first. kind: first sell, buyback, or re-sell. */
  trades: Array<{ t: number; slot: number; cycle: number; side: 'BUY' | 'SELL'; kind: OrderKind; price: string; qty: string; profit: string | null }>;
  /** Closing price every 15 minutes, for the chart. */
  priceSeries: Array<[number, number]>;
  profitByDay: Array<{ day: string; cycles: number; profit: string }>;
}

/**
 * Replays real 1-minute candles through the exact series engine against the simulated venue.
 * Within each minute the price visits open -> low -> high -> close (open -> high -> low -> close on a
 * down candle), so an order fills only if the market actually traded through its price.
 */
export async function runSeriesBacktest(opts: {
  label: string; settings: SeriesSettings; specs: VenueSpecs; candles: Candle[];
}): Promise<SeriesBacktestReport> {
  const { settings, specs, candles } = opts;
  if (!candles.length) throw new Error('no candles');
  const clock = new FakeClock(candles[0].start);
  const store = new MemorySeriesStore();
  store.now = () => clock.now();
  const startPrice = candles[0].open;
  const plan = buildPlan(settings, startPrice, specs);
  const startZig = new Decimal(settings.totalZig);
  const startUsdt = new Decimal(settings.startUsdt);
  const run = await store.createRun({
    ownerId: 'backtest', mode: 'backtest', settings, basePrice: plan.basePrice, qty: plan.qty, startZig, startUsdt, startedAt: clock.now(),
  });
  const sim = new SimVenue({ specs, clock, startBase: startZig, startQuote: startUsdt, startPrice, spreadTicks: 1 });
  const engine = new SeriesEngine({
    run, plan, specs, venue: sim, store, lease: new MemoryLease(clock), leaseScope: 'backtest', holder: 'backtest', clock,
    log: silentLogger, alert: new CapturingAlerter() as Alerter, symbol: 'ZIGUSDT', feedStaleSeconds: 3600, leaseTtlSeconds: 3600,
  });
  await sim.start({
    onBook: (b) => engine.onBook(b), onFill: (f) => engine.onFill(f),
    onOrderUpdate: (u) => engine.onOrderUpdate(u), onFeedStatus: (f, c) => engine.onFeedStatus(f, c),
  });
  await engine.start();
  await sim.drain();

  let maxOwed = new Decimal(0);
  const priceSeries: Array<[number, number]> = [];
  let low = startPrice;
  let high = startPrice;
  for (const c of candles) {
    if (engine.getStatus() !== 'RUNNING') break;
    if (c.low.lt(low)) low = c.low;
    if (c.high.gt(high)) high = c.high;
    if ((c.start / 60_000) % 15 === 0) priceSeries.push([c.start, c.close.toNumber()]);
    const path = c.close.gte(c.open) ? [c.open, c.low, c.high, c.close] : [c.open, c.high, c.low, c.close];
    for (let i = 0; i < path.length; i++) {
      clock.set(c.start + i * 15_000);
      await engine.renewLease();
      await sim.moveTo(path[i]);
      await engine.tick();
      await sim.drain();
      await engine.idle();
    }
    const o = engine.getSlots().reduce((s, x) => s.plus(owed(x)), new Decimal(0)).abs();
    if (o.gt(maxOwed)) maxOwed = o;
    if ((c.start / 60_000) % 60 === 0) { await engine.checkNow(); await sim.drain(); }
  }
  await engine.checkNow();

  const snap = engine.snapshot();
  const cycles = engine.getCycles();
  const last = candles[candles.length - 1];
  const balances = await sim.getBalances();
  const endPrice = last.close;
  const open = await sim.getOpenOrders();
  const fills = sim.log.filter((e) => e.kind === 'fill');
  const places = sim.log.filter((e) => e.kind === 'place');
  const byDay = new Map<string, { cycles: number; profit: Decimal }>();
  const bySlot: Record<string, number> = {};
  let fees = new Decimal(0);
  for (const cy of cycles) {
    const day = new Date(cy.closedAt).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { cycles: 0, profit: new Decimal(0) };
    d.cycles += 1;
    d.profit = d.profit.plus(cy.profit);
    byDay.set(day, d);
    bySlot[`#${cy.slot}`] = (bySlot[`#${cy.slot}`] ?? 0) + 1;
  }
  for (const f of fills) fees = fees.plus(f.feeAsset === 'quote' ? f.feeAmount : f.feeAmount.mul(f.price));
  const direction = directionOf(settings);
  const kindOf = (id: string, side: 'BUY' | 'SELL') => orderKind(direction, side, parseSeriesOrderId(id)?.cycle ?? 1);
  const count = (rows: Array<{ id: string; side: 'BUY' | 'SELL' }>) => {
    const out = { firstSells: 0, buybacks: 0, resells: 0 };
    for (const r of rows) {
      const k = kindOf(r.id, r.side);
      if (k === 'BUYBACK' || k === 'SELLBACK') out.buybacks++;
      else if (k === 'RESELL' || k === 'REBUY') out.resells++;
      else out.firstSells++;
    }
    return out;
  };
  const okPlaces = places.flatMap((p) => (p.kind === 'place' && p.ok ? [{ id: p.id, side: p.side }] : []));
  const fillRows = fills.flatMap((f) => (f.kind === 'fill' ? [f] : []));
  const trades = fillRows.map((f) => {
    const p = parseSeriesOrderId(f.id);
    const kind = kindOf(f.id, f.side);
    const slot = p?.slot ?? 0;
    const cycle = p?.cycle ?? 0;
    // A buyback fill that closed its loop carries the loop's profit.
    const closed = f.side === 'BUY' ? cycles.find((c) => c.slot === slot && c.cycle === cycle && c.closedAt === f.t) : undefined;
    return { t: f.t, slot, cycle, side: f.side, kind, price: f.price.toFixed(), qty: f.qty.toFixed(), profit: closed ? closed.profit.toFixed(4) : null };
  });
  const slotRows = engine.getSlots().map((s) => {
    const mine = cycles.filter((c) => c.slot === s.slot);
    return {
      slot: s.slot,
      firstSell: plan.orders[s.slot - 1].price.toFixed(),
      cycles: mine.length,
      profit: mine.reduce((n, c) => n.plus(c.profit), new Decimal(0)).toFixed(4),
      state: s.state,
      cycle: s.cycle,
      livePrice: s.order ? s.order.price.toFixed() : null,
      owedZig: owed(s).toFixed(),
    };
  });
  const days = (last.start - candles[0].start) / 86_400_000 || 1;
  // Opening orders filled completely: every closed loop, plus every slot now waiting on its closing order.
  const closingState = direction === 'BUY_FIRST' ? 'SELL_LIVE' : 'BUY_LIVE';
  const sellsCompleted = cycles.length + engine.getSlots().filter((s) => s.state === closingState).length;
  return {
    label: opts.label,
    from: new Date(candles[0].start).toISOString(),
    to: new Date(last.start).toISOString(),
    days: Math.round(days * 10) / 10,
    candles: candles.length,
    startPrice: startPrice.toFixed(),
    endPrice: endPrice.toFixed(),
    lowPrice: low.toFixed(),
    highPrice: high.toFixed(),
    basePrice: plan.basePrice.toFixed(),
    firstSell: plan.orders[0].price.toFixed(),
    lastSell: plan.orders[plan.orders.length - 1].price.toFixed(),
    qtyPerOrder: plan.qty.toFixed(),
    ordersPlaced: places.filter((p) => p.kind === 'place' && p.ok).length,
    ordersRejected: places.filter((p) => p.kind === 'place' && !p.ok).length,
    sellFills: fills.filter((f) => f.kind === 'fill' && f.side === 'SELL').length,
    buyFills: fills.filter((f) => f.kind === 'fill' && f.side === 'BUY').length,
    sellsCompleted,
    cyclesCompleted: cycles.length,
    cyclesPerDay: Math.round((cycles.length / days) * 10) / 10,
    realisedProfitUsd: cycles.reduce((s, c) => s.plus(c.profit), new Decimal(0)).toFixed(2),
    feesPaidUsd: fees.toFixed(2),
    zigStillSold: snap.zigSold,
    maxZigSold: maxOwed.toFixed(),
    reserveEndUsd: new Decimal(snap.reserve).toFixed(2),
    openSellsEnd: open.filter((o) => o.side === 'SELL').length,
    openBuysEnd: open.filter((o) => o.side === 'BUY').length,
    markToMarketUsd: balances.base.mul(endPrice).plus(balances.quote).minus(startZig.mul(startPrice).plus(startUsdt)).toFixed(2),
    holdUsd: startZig.mul(endPrice.minus(startPrice)).toFixed(2),
    status: engine.getStatus(),
    statusReason: snap.statusReason,
    cyclesBySlot: bySlot,
    direction,
    placedByKind: count(okPlaces),
    filledByKind: count(fillRows.map((f) => ({ id: f.id, side: f.side }))),
    slots: slotRows,
    trades,
    priceSeries,
    profitByDay: [...byDay.entries()].map(([day, v]) => ({ day, cycles: v.cycles, profit: v.profit.toFixed(2) })),
  };
}
