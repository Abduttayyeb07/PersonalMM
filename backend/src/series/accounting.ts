import Decimal from 'decimal.js';
import { buybackQty } from '../engine/rung-accounting';
import { Fill, VenueSpecs } from '../engine/types';
import { parseSeriesOrderId } from './order-id';
import { buybackPrice, resellPrice } from './plan';
import { Slot, SeriesCycle, SeriesSettings } from './types';

const ZERO = new Decimal(0);

export function newSlot(slot: number, qty: Decimal, sellPrice: Decimal): Slot {
  return {
    slot, state: 'SELL_LIVE', cycle: 1, qty, sellTarget: sellPrice, buyTarget: null,
    legQty: qty, legFilled: ZERO, revision: 0, order: null,
    soldQty: ZERO, soldQuote: ZERO, feeSellQuote: ZERO, boughtGross: ZERO, boughtNet: ZERO, buyCost: ZERO,
    feeBuyQuote: ZERO, openedAt: 0,
  };
}

export const cloneSlot = (s: Slot): Slot => ({ ...s, order: s.order ? { ...s.order } : null });
export const remaining = (s: Slot) => s.legQty.minus(s.legFilled);
/** Base sold and not yet received back for this slot. */
export const owed = (s: Slot) => s.soldQty.minus(s.boughtNet);
/** Quote locked behind this slot's open buyback (sell proceeds less what the buyback has spent). */
export const reserveOf = (s: Slot) => (s.soldQty.gt(0) ? s.soldQuote.minus(s.buyCost) : ZERO);

const quoteFee = (f: Fill) => (f.feeAsset === 'quote' ? f.feeAmount : f.feeAmount.mul(f.price));

export interface SeriesFillResult {
  slot: Slot;
  cycle?: SeriesCycle;
  outcome: 'PARTIAL' | 'SELL_DONE' | 'CYCLE_CLOSED';
}

/**
 * Applies one fill to a slot. Full fill gates the next step: the buyback is created only when the sell
 * is 100% filled, and the re-sell only when the buyback is 100% filled.
 */
export function applySeriesFill(prev: Slot, f: Fill, settings: SeriesSettings, specs: VenueSpecs): SeriesFillResult {
  const id = parseSeriesOrderId(f.clientOrderId);
  if (!id || id.slot !== prev.slot) throw new Error(`fill ${f.fillId} does not belong to slot ${prev.slot}`);
  if (id.cycle !== prev.cycle) throw new Error(`fill ${f.fillId} is for cycle ${id.cycle}, slot is on ${prev.cycle}`);
  const s = cloneSlot(prev);

  if (f.side === 'SELL') {
    if (s.state !== 'SELL_LIVE') throw new Error(`sell fill on slot ${s.slot} in state ${s.state}`);
    s.legFilled = s.legFilled.plus(f.qty);
    s.soldQty = s.soldQty.plus(f.qty);
    const fee = quoteFee(f);
    s.soldQuote = s.soldQuote.plus(f.price.mul(f.qty)).minus(fee);
    s.feeSellQuote = s.feeSellQuote.plus(fee);
    if (s.openedAt === 0) s.openedAt = f.ts;
    if (remaining(s).gte(specs.lot)) return { slot: s, outcome: 'PARTIAL' };
    // Sell is 100% filled: aim the buyback below the average price it actually sold at.
    const avgSell = s.soldQuote.plus(s.feeSellQuote).div(s.soldQty);
    s.state = 'BUY_LIVE';
    s.buyTarget = buybackPrice(avgSell, new Decimal(settings.buybackPct), specs.tick);
    s.legQty = buybackQty(s.soldQty, specs);
    s.legFilled = ZERO;
    s.revision = 0;
    s.order = null;
    s.waiting = undefined;
    return { slot: s, outcome: 'SELL_DONE' };
  }

  if (s.state !== 'BUY_LIVE') throw new Error(`buy fill on slot ${s.slot} in state ${s.state}`);
  s.legFilled = s.legFilled.plus(f.qty);
  s.boughtGross = s.boughtGross.plus(f.qty);
  const baseFee = f.feeAsset === 'base' ? f.feeAmount : ZERO;
  const quoteFeeAmount = f.feeAsset === 'quote' ? f.feeAmount : ZERO;
  s.boughtNet = s.boughtNet.plus(f.qty.minus(baseFee));
  s.buyCost = s.buyCost.plus(f.price.mul(f.qty)).plus(quoteFeeAmount);
  s.feeBuyQuote = s.feeBuyQuote.plus(quoteFeeAmount);
  if (remaining(s).gte(specs.lot)) return { slot: s, outcome: 'PARTIAL' };

  // Buyback is 100% filled: book the cycle, then re-sell above where we bought.
  const avgBuy = s.buyCost.minus(s.feeBuyQuote).div(s.boughtGross);
  const cycle: SeriesCycle = {
    slot: s.slot, cycle: s.cycle, soldQty: s.soldQty,
    avgSell: s.soldQuote.plus(s.feeSellQuote).div(s.soldQty), avgBuy,
    soldQuote: s.soldQuote, boughtGross: s.boughtGross, boughtNet: s.boughtNet, buyCost: s.buyCost,
    feeSellQuote: s.feeSellQuote, feeBuyQuote: s.feeBuyQuote, profit: s.soldQuote.minus(s.buyCost),
    openedAt: s.openedAt, closedAt: f.ts,
  };
  const next = newSlot(s.slot, s.qty, resellPrice(avgBuy, new Decimal(settings.resellPct), specs.tick));
  next.cycle = s.cycle + 1;
  return { slot: next, cycle, outcome: 'CYCLE_CLOSED' };
}
