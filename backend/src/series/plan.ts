import Decimal from 'decimal.js';
import { roundDown, roundUp } from '../engine/lattice';
import { VenueSpecs } from '../engine/types';
import { SeriesPlan, SeriesSettings } from './types';

export class SeriesSettingsError extends Error {}

const dec = (v: unknown, name: string) => {
  try {
    const d = new Decimal(String(v));
    if (!d.isFinite()) throw new Error();
    return d;
  } catch {
    throw new SeriesSettingsError(`${name} must be a number`);
  }
};

/** The defaults match the strategy: 15 sells, first at base +3%, 1% apart, buyback -3%, re-sell +3%. */
export function defaultSeriesSettings(): SeriesSettings {
  return {
    totalZig: '15000',
    startUsdt: '0',
    basePrice: null,
    sellPct: '10',
    orders: 15,
    firstSellPct: '3',
    stepPct: '1',
    buybackPct: '3',
    resellPct: '3',
    maxCycles: null,
    maxHours: null,
  };
}

/** Price a buyback is aimed at for a sell that filled at `sellPrice`: below it, rounded down to the tick. */
export function buybackPrice(sellPrice: Decimal, buybackPct: Decimal, tick: Decimal): Decimal {
  return roundDown(sellPrice.mul(new Decimal(1).minus(buybackPct.div(100))), tick);
}

/** Price a re-sell is aimed at for a buyback that filled at `buyPrice`: above it, rounded up to the tick. */
export function resellPrice(buyPrice: Decimal, resellPct: Decimal, tick: Decimal): Decimal {
  return roundUp(buyPrice.mul(new Decimal(1).plus(resellPct.div(100))), tick);
}

/**
 * Turns the user's settings into the exact orders the series starts with. Every value is bounded and
 * every order must clear the venue's minimum, so a typo cannot produce an order the exchange rejects.
 */
export function buildPlan(s: SeriesSettings, marketPrice: Decimal, specs: VenueSpecs): SeriesPlan {
  const totalZig = dec(s.totalZig, 'Total ZIG');
  const startUsdt = dec(s.startUsdt, 'Starting USDT');
  const sellPct = dec(s.sellPct, 'Share of ZIG for sale');
  const firstSell = dec(s.firstSellPct, 'First sell above base');
  const step = dec(s.stepPct, 'Step between sells');
  const buyback = dec(s.buybackPct, 'Buyback below sell');
  const resell = dec(s.resellPct, 'Re-sell above buyback');
  const base = s.basePrice === null || s.basePrice === '' ? marketPrice : dec(s.basePrice, 'Base price');

  if (totalZig.lt(1) || totalZig.gt(1e9)) throw new SeriesSettingsError('Total ZIG must be between 1 and 1,000,000,000');
  if (startUsdt.isNegative() || startUsdt.gt(1e8)) throw new SeriesSettingsError('Starting USDT must be between 0 and 100,000,000');
  if (sellPct.lte(0) || sellPct.gt(100)) throw new SeriesSettingsError('Share of ZIG for sale must be above 0% and at most 100%');
  if (!Number.isInteger(s.orders) || s.orders < 1 || s.orders > 50) throw new SeriesSettingsError('Number of orders must be a whole number from 1 to 50');
  if (firstSell.lt(0) || firstSell.gt(50)) throw new SeriesSettingsError('First sell must be 0% to 50% above the base');
  if (step.lt('0.1') || step.gt(20)) throw new SeriesSettingsError('Step between sells must be 0.1% to 20%');
  if (buyback.lt('0.5') || buyback.gt(30)) throw new SeriesSettingsError('Buyback must be 0.5% to 30% below the sell');
  if (resell.lt('0.5') || resell.gt(30)) throw new SeriesSettingsError('Re-sell must be 0.5% to 30% above the buyback');
  if (base.lte(0)) throw new SeriesSettingsError('Base price must be positive');
  if (s.maxCycles !== null && (!Number.isInteger(s.maxCycles) || s.maxCycles < 1)) throw new SeriesSettingsError('Stop after cycles must be a whole number of at least 1');
  if (s.maxHours !== null && (!(s.maxHours > 0) || s.maxHours > 24 * 90)) throw new SeriesSettingsError('Stop after hours must be between 0 and 2160');

  const zigForSale = totalZig.mul(sellPct).div(100);
  const qty = roundDown(zigForSale.div(s.orders), specs.lot);
  if (qty.lt(specs.lot)) throw new SeriesSettingsError('Each order would be below the exchange minimum size. Use more ZIG, a larger share, or fewer orders.');

  // First sell: base + first%, rounded up so it is never below that. Each next sell is the previous
  // order's price + step%, to the nearest tick (0.06077, 0.06138, 0.06199, ...).
  const orders: Array<{ slot: number; sellPrice: Decimal }> = [];
  let price = roundUp(base.mul(new Decimal(1).plus(firstSell.div(100))), specs.tick);
  for (let i = 0; i < s.orders; i++) {
    if (i > 0) {
      const nextPrice = price.mul(new Decimal(1).plus(step.div(100))).toNearest(specs.tick, Decimal.ROUND_HALF_UP);
      price = nextPrice.gt(price) ? nextPrice : price.plus(specs.tick);
    }
    orders.push({ slot: i + 1, sellPrice: price });
  }

  // The smallest order in the loop is the first buyback: it must still clear the exchange minimum.
  const smallest = Decimal.min(
    qty.mul(orders[0].sellPrice),
    qty.mul(buybackPrice(orders[0].sellPrice, buyback, specs.tick)),
  );
  if (smallest.lt(specs.minOrderValue)) {
    const need = specs.minOrderValue.div(buybackPrice(orders[0].sellPrice, buyback, specs.tick)).mul(s.orders).div(sellPct.div(100));
    throw new SeriesSettingsError(
      `Each order is worth ${smallest.toFixed(2)} USDT, below the exchange minimum of ${specs.minOrderValue} USDT. ` +
      `With ${s.orders} orders and ${sellPct.toFixed()}% for sale you need about ${need.toDecimalPlaces(0, Decimal.ROUND_UP).toFixed()} ZIG, or use fewer orders or a larger share.`,
    );
  }
  if (qty.mul(s.orders).gt(totalZig)) throw new SeriesSettingsError('The orders would sell more ZIG than you hold');
  return { basePrice: base, qty, zigForSale: qty.mul(s.orders), orders };
}
