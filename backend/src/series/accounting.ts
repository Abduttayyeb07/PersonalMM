import Decimal from 'decimal.js';
import { roundDown } from '../engine/lattice';
import { buybackQty } from '../engine/rung-accounting';
import { Fill, VenueSpecs } from '../engine/types';
import { parseSeriesOrderId } from './order-id';
import { buybackPrice, resellPrice } from './plan';
import { Slot, SeriesCycle, SeriesSettings, directionOf } from './types';

const ZERO = new Decimal(0);

/** A fresh loop for one order slot, opening with a sell (selling first) or a buy (buying first). */
export function newSlot(slot: number, qty: Decimal, price: Decimal, side: 'BUY' | 'SELL' = 'SELL'): Slot {
  return {
    slot, state: side === 'SELL' ? 'SELL_LIVE' : 'BUY_LIVE', cycle: 1, qty,
    sellTarget: side === 'SELL' ? price : ZERO, buyTarget: side === 'BUY' ? price : null,
    legQty: qty, legFilled: ZERO, revision: 0, order: null,
    soldQty: ZERO, soldQuote: ZERO, feeSellQuote: ZERO, boughtGross: ZERO, boughtNet: ZERO, buyCost: ZERO,
    feeBuyQuote: ZERO, openedAt: 0,
  };
}

export const cloneSlot = (s: Slot): Slot => ({ ...s, order: s.order ? { ...s.order } : null });
export const remaining = (s: Slot) => s.legQty.minus(s.legFilled);
/**
 * Base sold and not yet received back for this slot. Negative when buying first: ZIG bought and not
 * yet sold back.
 */
export const owed = (s: Slot) => s.soldQty.minus(s.boughtNet);
/**
 * Quote this slot's open loop has added to (or, buying first, taken from) the account: sell proceeds
 * less what the buys have spent. Zero for a loop that has not started.
 */
export const reserveOf = (s: Slot) => s.soldQuote.minus(s.buyCost);

const quoteFee = (f: Fill) => (f.feeAsset === 'quote' ? f.feeAmount : f.feeAmount.mul(f.price));

export interface SeriesFillResult {
  slot: Slot;
  cycle?: SeriesCycle;
  /** OPEN_DONE: the opening order (sell when selling first, buy when buying first) filled completely. */
  outcome: 'PARTIAL' | 'OPEN_DONE' | 'CYCLE_CLOSED';
}

function addSell(s: Slot, f: Fill) {
  s.legFilled = s.legFilled.plus(f.qty);
  s.soldQty = s.soldQty.plus(f.qty);
  const fee = quoteFee(f);
  s.soldQuote = s.soldQuote.plus(f.price.mul(f.qty)).minus(fee);
  s.feeSellQuote = s.feeSellQuote.plus(fee);
}

function addBuy(s: Slot, f: Fill) {
  s.legFilled = s.legFilled.plus(f.qty);
  s.boughtGross = s.boughtGross.plus(f.qty);
  const baseFee = f.feeAsset === 'base' ? f.feeAmount : ZERO;
  const quoteFeeAmount = f.feeAsset === 'quote' ? f.feeAmount : ZERO;
  s.boughtNet = s.boughtNet.plus(f.qty.minus(baseFee));
  s.buyCost = s.buyCost.plus(f.price.mul(f.qty)).plus(quoteFeeAmount);
  s.feeBuyQuote = s.feeBuyQuote.plus(quoteFeeAmount);
}

const avgSellOf = (s: Slot) => s.soldQuote.plus(s.feeSellQuote).div(s.soldQty);
const avgBuyOf = (s: Slot) => s.buyCost.minus(s.feeBuyQuote).div(s.boughtGross);

function closeCycle(s: Slot, f: Fill): SeriesCycle {
  return {
    slot: s.slot, cycle: s.cycle, soldQty: s.soldQty, avgSell: avgSellOf(s), avgBuy: avgBuyOf(s),
    soldQuote: s.soldQuote, boughtGross: s.boughtGross, boughtNet: s.boughtNet, buyCost: s.buyCost,
    feeSellQuote: s.feeSellQuote, feeBuyQuote: s.feeBuyQuote, profit: s.soldQuote.minus(s.buyCost),
    openedAt: s.openedAt, closedAt: f.ts,
  };
}

/**
 * Applies one fill to a slot. Full fill gates the next step: the closing order is created only when
 * the opening order is 100% filled, and the next loop only when the closing order is 100% filled.
 *
 * Selling first: sell -> buyback (-buyback%, grossed up for the fee taken in ZIG) -> re-sell (+resell%).
 * Buying first: buy -> sell-back of the ZIG received (+resell%) -> re-buy (-buyback%).
 */
export function applySeriesFill(prev: Slot, f: Fill, settings: SeriesSettings, specs: VenueSpecs): SeriesFillResult {
  const id = parseSeriesOrderId(f.clientOrderId);
  if (!id || id.slot !== prev.slot) throw new Error(`fill ${f.fillId} does not belong to slot ${prev.slot}`);
  if (id.cycle !== prev.cycle) throw new Error(`fill ${f.fillId} is for cycle ${id.cycle}, slot is on ${prev.cycle}`);
  const expected = prev.state === 'SELL_LIVE' ? 'SELL' : 'BUY';
  if (f.side !== expected) throw new Error(`${f.side.toLowerCase()} fill on slot ${prev.slot} in state ${prev.state}`);
  const buyFirst = directionOf(settings) === 'BUY_FIRST';
  const opening = buyFirst ? f.side === 'BUY' : f.side === 'SELL';
  const s = cloneSlot(prev);
  if (f.side === 'SELL') addSell(s, f); else addBuy(s, f);
  if (opening && s.openedAt === 0) s.openedAt = f.ts;
  if (remaining(s).gte(specs.lot)) return { slot: s, outcome: 'PARTIAL' };

  if (opening) {
    // The opening order is 100% filled: aim the closing order from the average price it actually got.
    s.legFilled = ZERO;
    s.revision = 0;
    s.order = null;
    s.waiting = undefined;
    if (buyFirst) {
      s.state = 'SELL_LIVE';
      s.sellTarget = resellPrice(avgBuyOf(s), new Decimal(settings.resellPct), specs.tick);
      // Sell back exactly the ZIG received (the buy fee was taken in ZIG), down to the lot.
      s.legQty = roundDown(s.boughtNet, specs.lot);
    } else {
      s.state = 'BUY_LIVE';
      s.buyTarget = buybackPrice(avgSellOf(s), new Decimal(settings.buybackPct), specs.tick);
      s.legQty = buybackQty(s.soldQty, specs);
    }
    return { slot: s, outcome: 'OPEN_DONE' };
  }

  // The closing order is 100% filled: book the loop, then start the next one from where it closed.
  const cycle = closeCycle(s, f);
  const next = buyFirst
    ? newSlot(s.slot, s.qty, buybackPrice(cycle.avgSell, new Decimal(settings.buybackPct), specs.tick), 'BUY')
    : newSlot(s.slot, s.qty, resellPrice(cycle.avgBuy, new Decimal(settings.resellPct), specs.tick), 'SELL');
  next.cycle = s.cycle + 1;
  return { slot: next, cycle, outcome: 'CYCLE_CLOSED' };
}
