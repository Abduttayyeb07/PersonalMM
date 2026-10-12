import Decimal from 'decimal.js';
import { PairConfig } from './config/engine-config';
import { Genesis } from './ledger/ledger';
import { CycleRecord, RungRecord, owed } from './rung-accounting';
import { Balances, OpenOrder, VenueSpecs } from './types';

export interface InvariantSnapshot {
  cfg: PairConfig;
  specs: VenueSpecs;
  genesis: Genesis;
  /** Totals on the exchange (free + locked). */
  balances: Balances;
  rungs: RungRecord[];
  openOrders: OpenOrder[];
  cycles: CycleRecord[];
  sweepsTotal: Decimal;
  /** Profit balance as the ledger keeps it incrementally. */
  profitBalance: Decimal;
  leaseValid: boolean;
  runningHash: string;
  approvedHash: string | null;
  /** When true I10 must hold (live trading). Paper and backtests have no approval to compare. */
  requireApproval: boolean;
  /** Grace for rungs that legitimately have no order yet (placement in flight). */
  nowMs: number;
}

export interface Breach {
  id: string;
  message: string;
  /** Numbers on both sides, for the alert. */
  left: string;
  right: string;
  /** True when the breach must stop every pair (shared-service invariants). */
  global?: boolean;
}

const ZERO = new Decimal(0);

/** Reserve: quote locked up behind open buybacks. Profit: cycles closed minus sweeps. */
export function reserveOf(rungs: RungRecord[]): Decimal {
  return rungs.reduce((sum, r) => (r.soldQty.gt(0) ? sum.plus(r.soldQuote).minus(r.buyCost) : sum), ZERO);
}

/** Base gained (or lost) to lot rounding across completed cycles. */
export function baseResidual(cycles: CycleRecord[]): Decimal {
  return cycles.reduce((sum, c) => sum.plus(c.boughtNet).minus(c.soldQty), ZERO);
}

export function profitOf(cycles: CycleRecord[], sweeps: Decimal): Decimal {
  return cycles.reduce((sum, c) => sum.plus(c.profit), ZERO).minus(sweeps);
}

export function checkInvariants(s: InvariantSnapshot): Breach[] {
  const breaches: Breach[] = [];
  const add = (id: string, message: string, left: Decimal | string, right: Decimal | string, global = false) =>
    breaches.push({ id, message, left: String(left), right: String(right), global });

  const totalOwed = s.rungs.reduce((sum, r) => sum.plus(owed(r)), ZERO);
  const reserve = reserveOf(s.rungs);
  const profit = profitOf(s.cycles, s.sweepsTotal);

  // I1: base held + base owed = base at start. Buybacks round UP to the lot so a cycle never returns
  // less than it sold; that per-cycle residual (at most one lot) is measured, not hidden.
  const residual = baseResidual(s.cycles);
  const baseHeldPlusOwed = s.balances.base.plus(totalOwed);
  const expectedBase = s.genesis.baseAtStart.plus(residual);
  if (baseHeldPlusOwed.minus(expectedBase).abs().gt(s.cfg.dustToleranceBase)) {
    add('I1', 'base held + base owed differs from base at start (+ cycle rounding residual)', baseHeldPlusOwed.toFixed(), expectedBase.toFixed());
  }
  for (const c of s.cycles) {
    const r = c.boughtNet.minus(c.soldQty);
    if (r.abs().gt(s.specs.lot)) add('I1', `cycle ${c.rungKey}#${c.cycle} did not buy back the quantity it sold`, c.boughtNet.toFixed(), c.soldQty.toFixed());
  }

  // I2: reserve covers every open buyback at its cap price (the buy fee is inside the gross quantity).
  let needed = ZERO;
  for (const r of s.rungs) {
    if (r.state === 'BUY_LIVE') needed = needed.plus(r.buyPrice.mul(r.legQty.minus(r.legFilled)));
  }
  if (reserve.lt(needed.minus(s.cfg.dustToleranceQuote))) {
    add('I2', 'reserve does not cover open buybacks at their cap', reserve.toFixed(), needed.toFixed());
  }

  // I3: quote held = quote at start + reserve + unswept profit.
  const expectedQuote = s.genesis.quoteAtStart.plus(reserve).plus(profit);
  if (s.balances.quote.minus(expectedQuote).abs().gt(s.cfg.dustToleranceQuote)) {
    add('I3', 'quote held differs from quote at start + reserve + profit', s.balances.quote.toFixed(), expectedQuote.toFixed());
  }

  // I4: every live rung has exactly one live order; every IDLE rung has none.
  const byId = new Map<string, OpenOrder[]>();
  for (const o of s.openOrders) byId.set(o.clientOrderId, [...(byId.get(o.clientOrderId) ?? []), o]);
  for (const r of s.rungs) {
    if (r.state === 'IDLE') {
      if (r.order) add('I4', `IDLE rung ${r.key} has an order`, r.order.clientOrderId, 'none');
      continue;
    }
    if (!r.order || r.order.status === 'INTENT') continue; // placement in flight or deliberately deferred
    const found = byId.get(r.order.clientOrderId) ?? [];
    if (r.order.status === 'LIVE' && found.length !== 1) {
      add('I4', `rung ${r.key} should have exactly one live order`, String(found.length), '1');
    }
  }

  // I5: every exchange order belongs to a rung (and the current lease epoch).
  const known = new Set(s.rungs.flatMap((r) => (r.order ? [r.order.clientOrderId] : [])));
  for (const o of s.openOrders) {
    if (!known.has(o.clientOrderId)) add('I5', 'exchange order does not belong to any rung', o.clientOrderId, 'unknown', true);
  }
  if (!s.leaseValid) add('I5', 'lease epoch is no longer current', 'stale', 'current', true);

  // I6 + I7 against what is actually resting on the exchange.
  const sells = s.openOrders.filter((o) => o.side === 'SELL');
  const buys = s.openOrders.filter((o) => o.side === 'BUY');
  if (sells.length && buys.length) {
    const lowestSell = Decimal.min(...sells.map((o) => o.price));
    const highestBuy = Decimal.max(...buys.map((o) => o.price));
    if (highestBuy.gte(lowestSell)) add('I6', 'highest live buy is not below lowest live sell', highestBuy.toFixed(), lowestSell.toFixed());
  }
  const rungByOrder = new Map(s.rungs.filter((r) => r.order).map((r) => [r.order!.clientOrderId, r]));
  for (const o of s.openOrders) {
    const r = rungByOrder.get(o.clientOrderId);
    if (!r) continue;
    if (o.side === 'SELL' && (o.price.lt(r.sellPrice) || o.price.lt(s.cfg.floorPrice))) {
      add('I7', `sell on ${r.key} is below its rung price`, o.price.toFixed(), r.sellPrice.toFixed());
    }
    if (o.side === 'BUY' && o.price.gt(r.buyPrice)) add('I7', `buy on ${r.key} is above its buyback price`, o.price.toFixed(), r.buyPrice.toFixed());
  }

  // I8: every completed cycle has net profit >= 0.
  for (const c of s.cycles) {
    if (c.profit.isNegative()) add('I8', `cycle ${c.rungKey}#${c.cycle} lost money`, c.profit.toFixed(), '>= 0');
  }

  // I9: the profit balance the ledger keeps equals the sum of cycle profits minus sweeps.
  if (s.profitBalance.minus(profit).abs().gt(s.cfg.dustToleranceQuote)) {
    add('I9', 'profit balance differs from the sum of cycle profits minus sweeps', s.profitBalance.toFixed(), profit.toFixed());
  }

  // I10: running config hash = approved hash.
  if (s.requireApproval && s.approvedHash !== s.runningHash) {
    add('I10', 'running config hash does not match the approved hash', s.runningHash, s.approvedHash ?? 'none', true);
  }
  return breaches;
}
