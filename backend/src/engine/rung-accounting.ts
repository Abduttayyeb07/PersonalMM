import Decimal from 'decimal.js';
import { PairConfig } from './config/engine-config';
import { LatticeRung, roundUp } from './lattice';
import { parseOrderId } from './order-id';
import { Fill, RungState, Side, VenueSpecs } from './types';

/**
 * Pure accounting for one rung. The live engine and the "rebuild the rung table from fill events"
 * check both use these functions, so they cannot drift apart.
 */

export interface LiveOrder {
  clientOrderId: string;
  side: Side;
  price: Decimal;
  /** Quantity this order was placed for. */
  qty: Decimal;
  revision: number;
  status: 'INTENT' | 'LIVE' | 'CANCELING';
  /** Why the order is being cancelled, so the cancel confirmation knows what to do next. */
  pending?: 'REPLACE' | 'EXCEPTION' | 'NET';
  placedAt: number;
  orderId?: string;
  /** Cumulative quantity filled on THIS order, as seen from fill events. */
  filled: Decimal;
  /** Filled quantity the venue reported on cancel. The cancel is processed once our fills catch up. */
  ackedFilled?: Decimal;
  /** Rung key being netted against while this order is cancelled for netting. */
  netWith?: string;
  /** Placed away from its rung price because the market was already through the target. Only a
   * pegged order follows the book; an order at its rung price rests and never moves. */
  pegged?: boolean;
}

export interface RungRecord {
  key: string;
  ladder: string;
  n: number;
  sellPrice: Decimal;
  buyPrice: Decimal;
  state: RungState;
  cycle: number;
  /** Target quantity of the current leg (rung size for a sell, gross buyback quantity for a buy). */
  legQty: Decimal;
  legFilled: Decimal;
  /** Highest order revision used in the current leg. */
  revision: number;
  order: LiveOrder | null;
  /** Set while a live rung deliberately has no order (for example a self-cross deferral). */
  waiting?: string;
  // Accumulators for the current cycle (all in decimal strings when persisted).
  soldQty: Decimal;
  soldQuote: Decimal; // proceeds net of the sell fee
  feeSellQuote: Decimal;
  boughtGross: Decimal;
  boughtNet: Decimal; // base actually received
  buyCost: Decimal; // quote spent including any quote-denominated fee
  feeBuyQuote: Decimal;
  feeBuyBase: Decimal;
  openedAt: number;
  /** True when part of this cycle was booked by internal netting rather than an exchange trade. */
  nettedLeg: boolean;
}

export interface CycleRecord {
  rungKey: string;
  cycle: number;
  soldQty: Decimal;
  avgSell: Decimal;
  soldQuote: Decimal;
  boughtGross: Decimal;
  boughtNet: Decimal;
  avgBuy: Decimal;
  buyCost: Decimal;
  feeSellQuote: Decimal;
  feeBuyQuote: Decimal;
  feeBuyBase: Decimal;
  profit: Decimal;
  openedAt: number;
  closedAt: number;
  netted: boolean;
}

const ZERO = new Decimal(0);

export function newRung(l: LatticeRung, cfg: PairConfig): RungRecord {
  return {
    key: l.key, ladder: l.ladder, n: l.n, sellPrice: l.sellPrice, buyPrice: l.buyPrice,
    state: 'IDLE', cycle: 1, legQty: cfg.rungSizeBase, legFilled: ZERO, revision: 0, order: null,
    soldQty: ZERO, soldQuote: ZERO, feeSellQuote: ZERO, boughtGross: ZERO, boughtNet: ZERO, buyCost: ZERO,
    feeBuyQuote: ZERO, feeBuyBase: ZERO, openedAt: 0, nettedLeg: false,
  };
}

export function cloneRung(r: RungRecord): RungRecord {
  return { ...r, order: r.order ? { ...r.order } : null };
}

export function remaining(r: RungRecord): Decimal {
  return r.legQty.minus(r.legFilled);
}

/** Base we sold and have not yet received back for this rung. */
export function owed(r: RungRecord): Decimal {
  return r.soldQty.minus(r.boughtNet);
}

/** Quantity to buy back for what was sold. If the venue takes the buy fee in base, gross it up. */
export function buybackQty(soldQty: Decimal, specs: VenueSpecs): Decimal {
  const target = specs.buyFeeAsset === 'base' ? soldQty.div(new Decimal(1).minus(specs.makerFee)) : soldQty;
  return roundUp(target, specs.lot);
}

function resetCycle(r: RungRecord, cfg: PairConfig): void {
  r.soldQty = ZERO; r.soldQuote = ZERO; r.feeSellQuote = ZERO;
  r.boughtGross = ZERO; r.boughtNet = ZERO; r.buyCost = ZERO; r.feeBuyQuote = ZERO; r.feeBuyBase = ZERO;
  r.legQty = cfg.rungSizeBase; r.legFilled = ZERO; r.revision = 0; r.order = null; r.waiting = undefined;
  r.nettedLeg = false;
}

/** Sell leg is over (fully filled, or cancelled with a partial fill): start the buyback for what sold. */
export function startBuyLeg(r: RungRecord, specs: VenueSpecs): RungRecord {
  const next = cloneRung(r);
  next.state = 'BUY_LIVE';
  next.legQty = buybackQty(next.soldQty, specs);
  next.legFilled = ZERO;
  next.revision = 0;
  next.order = null;
  next.waiting = undefined;
  return next;
}

const quoteFee = (f: Fill) => (f.feeAsset === 'quote' ? f.feeAmount : f.feeAmount.mul(f.price));

export interface FillResult {
  rung: RungRecord;
  cycle?: CycleRecord;
  /** What happened to the leg. */
  outcome: 'PARTIAL' | 'SELL_DONE' | 'CYCLE_CLOSED';
}

export function legIsComplete(r: RungRecord, specs: VenueSpecs): boolean {
  return remaining(r).lt(specs.lot);
}

/** Applies one fill to a rung. Throws if the fill does not belong to the rung's current leg. */
export function applyFill(rung: RungRecord, f: Fill, cfg: PairConfig, specs: VenueSpecs): FillResult {
  const id = parseOrderId(f.clientOrderId);
  if (!id || id.rungKey !== rung.key) throw new Error(`fill ${f.fillId} does not belong to rung ${rung.key}`);
  if (id.cycle !== rung.cycle) throw new Error(`fill ${f.fillId} is for cycle ${id.cycle}, rung is on ${rung.cycle}`);
  const r = cloneRung(rung);

  if (f.side === 'SELL') {
    if (r.state !== 'SELL_LIVE') throw new Error(`sell fill on rung ${r.key} in state ${r.state}`);
    r.legFilled = r.legFilled.plus(f.qty);
    r.soldQty = r.soldQty.plus(f.qty);
    const fee = quoteFee(f);
    r.soldQuote = r.soldQuote.plus(f.price.mul(f.qty)).minus(fee);
    r.feeSellQuote = r.feeSellQuote.plus(fee);
    if (r.openedAt === 0) r.openedAt = f.ts;
    if (f.netted) r.nettedLeg = true;
    if (legIsComplete(r, specs)) return { rung: startBuyLeg(r, specs), outcome: 'SELL_DONE' };
    return { rung: r, outcome: 'PARTIAL' };
  }

  if (r.state !== 'BUY_LIVE') throw new Error(`buy fill on rung ${r.key} in state ${r.state}`);
  r.legFilled = r.legFilled.plus(f.qty);
  r.boughtGross = r.boughtGross.plus(f.qty);
  const baseFee = f.feeAsset === 'base' ? f.feeAmount : ZERO;
  const quoteFeeAmount = f.feeAsset === 'quote' ? f.feeAmount : ZERO;
  r.boughtNet = r.boughtNet.plus(f.qty.minus(baseFee));
  r.buyCost = r.buyCost.plus(f.price.mul(f.qty)).plus(quoteFeeAmount);
  r.feeBuyBase = r.feeBuyBase.plus(baseFee);
  r.feeBuyQuote = r.feeBuyQuote.plus(quoteFeeAmount);
  if (f.netted) r.nettedLeg = true;

  if (!legIsComplete(r, specs)) return { rung: r, outcome: 'PARTIAL' };

  const profit = r.soldQuote.minus(r.buyCost);
  const cycle: CycleRecord = {
    rungKey: r.key, cycle: r.cycle, soldQty: r.soldQty,
    avgSell: r.soldQty.isZero() ? ZERO : r.soldQuote.plus(r.feeSellQuote).div(r.soldQty),
    soldQuote: r.soldQuote, boughtGross: r.boughtGross, boughtNet: r.boughtNet,
    avgBuy: r.boughtGross.isZero() ? ZERO : r.buyCost.minus(r.feeBuyQuote).div(r.boughtGross),
    buyCost: r.buyCost, feeSellQuote: r.feeSellQuote, feeBuyQuote: r.feeBuyQuote, feeBuyBase: r.feeBuyBase,
    profit, openedAt: r.openedAt, closedAt: f.ts, netted: r.nettedLeg,
  };
  r.cycle += 1;
  r.state = 'SELL_LIVE';
  resetCycle(r, cfg);
  return { rung: r, cycle, outcome: 'CYCLE_CLOSED' };
}

/** A new sell leg for an IDLE rung or a rung whose cycle just closed. */
export function armSell(r: RungRecord, cfg: PairConfig): RungRecord {
  const next = cloneRung(r);
  next.state = 'SELL_LIVE';
  resetCycle(next, cfg);
  return next;
}

/**
 * Rebuilds the rung table from the fill events alone (spec: the rung table is rebuildable from fills).
 * Orders that never filled leave no trace, so a rung with no fills is IDLE or an unfilled live sell;
 * callers reconcile that part against the venue's open orders.
 */
export function rebuildFromFills(
  lattice: LatticeRung[], fills: Fill[], cfg: PairConfig, specs: VenueSpecs,
): { rungs: Map<string, RungRecord>; cycles: CycleRecord[] } {
  const rungs = new Map(lattice.map((l) => [l.key, newRung(l, cfg)]));
  const cycles: CycleRecord[] = [];
  for (const f of fills) {
    const id = parseOrderId(f.clientOrderId);
    const rung = id ? rungs.get(id.rungKey) : undefined;
    if (!id || !rung) throw new Error(`fill ${f.fillId} has an order id we did not issue`);
    // A fill proves the rung was selling or buying in that cycle.
    const base = rung.state === 'IDLE' ? armSell(rung, cfg) : rung;
    // The stuck-partial-sell exception buys back a partial sell: a buy fill while a partial sell is open.
    const ready = f.side === 'BUY' && base.state === 'SELL_LIVE' && base.soldQty.gt(0) ? startBuyLeg(base, specs) : base;
    const result = applyFill(ready, f, cfg, specs);
    rungs.set(rung.key, result.rung);
    if (result.cycle) cycles.push(result.cycle);
  }
  return { rungs, cycles };
}

export function totalOwed(rungs: Iterable<RungRecord>): Decimal {
  let sum = ZERO;
  for (const r of rungs) sum = sum.plus(owed(r));
  return sum;
}
