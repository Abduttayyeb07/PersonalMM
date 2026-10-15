import Decimal from 'decimal.js';
import { roundDown, roundUp } from '../engine/lattice';
import { VenueSpecs } from '../engine/types';
import { SeriesPlan, SeriesSettings, directionOf } from './types';

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
    direction: 'SELL_FIRST',
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
 *
 * Selling first: sells go UP from the base (first at +first%, each next +step% above the last), equal
 * ZIG each, funded by ZIG. Buying first (the mirror): buys go DOWN from the base (first at -first%, each
 * next -step% below the last), equal ZIG each, funded by USDT.
 */
export function buildPlan(s: SeriesSettings, marketPrice: Decimal, specs: VenueSpecs): SeriesPlan {
  const direction = directionOf(s);
  if (direction !== 'SELL_FIRST' && direction !== 'BUY_FIRST') throw new SeriesSettingsError('Direction must be sell first or buy first');
  const buyFirst = direction === 'BUY_FIRST';
  const totalZig = dec(s.totalZig, 'Total ZIG');
  const startUsdt = dec(s.startUsdt, 'Starting USDT');
  const sharePct = dec(s.sellPct, buyFirst ? 'Share of USDT used' : 'Share of ZIG for sale');
  const first = dec(s.firstSellPct, buyFirst ? 'First buy below base' : 'First sell above base');
  const step = dec(s.stepPct, buyFirst ? 'Step between buys' : 'Step between sells');
  const buyback = dec(s.buybackPct, buyFirst ? 'Re-buy below sell-back' : 'Buyback below sell');
  const resell = dec(s.resellPct, buyFirst ? 'Sell-back above buy' : 'Re-sell above buyback');
  const base = s.basePrice === null || s.basePrice === '' ? marketPrice : dec(s.basePrice, 'Base price');

  if (buyFirst) {
    if (totalZig.isNegative() || totalZig.gt(1e9)) throw new SeriesSettingsError('Total ZIG must be between 0 and 1,000,000,000');
    if (startUsdt.lt(1) || startUsdt.gt(1e8)) throw new SeriesSettingsError('USDT to buy with must be between 1 and 100,000,000');
  } else {
    if (totalZig.lt(1) || totalZig.gt(1e9)) throw new SeriesSettingsError('Total ZIG must be between 1 and 1,000,000,000');
    if (startUsdt.isNegative() || startUsdt.gt(1e8)) throw new SeriesSettingsError('Starting USDT must be between 0 and 100,000,000');
  }
  if (sharePct.lte(0) || sharePct.gt(100)) throw new SeriesSettingsError(`Share of ${buyFirst ? 'USDT used' : 'ZIG for sale'} must be above 0% and at most 100%`);
  if (!Number.isInteger(s.orders) || s.orders < 1 || s.orders > 50) throw new SeriesSettingsError('Number of orders must be a whole number from 1 to 50');
  if (first.lt(0) || first.gt(50)) throw new SeriesSettingsError(`First ${buyFirst ? 'buy must be 0% to 50% below' : 'sell must be 0% to 50% above'} the base`);
  if (step.lt('0.1') || step.gt(20)) throw new SeriesSettingsError(`Step between ${buyFirst ? 'buys' : 'sells'} must be 0.1% to 20%`);
  if (buyback.lt('0.5') || buyback.gt(30)) throw new SeriesSettingsError(`${buyFirst ? 'Re-buy must be 0.5% to 30% below the sell-back' : 'Buyback must be 0.5% to 30% below the sell'}`);
  if (resell.lt('0.5') || resell.gt(30)) throw new SeriesSettingsError(`${buyFirst ? 'Sell-back must be 0.5% to 30% above the buy' : 'Re-sell must be 0.5% to 30% above the buyback'}`);
  if (base.lte(0)) throw new SeriesSettingsError('Base price must be positive');
  if (s.maxCycles !== null && (!Number.isInteger(s.maxCycles) || s.maxCycles < 1)) throw new SeriesSettingsError('Stop after cycles must be a whole number of at least 1');
  if (s.maxHours !== null && (!(s.maxHours > 0) || s.maxHours > 24 * 90)) throw new SeriesSettingsError('Stop after hours must be between 0 and 2160');

  // Prices: the first rounded away from the base (never closer than first%), each next one step%
  // beyond the previous order's price, to the nearest tick.
  const prices: Decimal[] = [];
  const one = new Decimal(1);
  let price = buyFirst
    ? roundDown(base.mul(one.minus(first.div(100))), specs.tick)
    : roundUp(base.mul(one.plus(first.div(100))), specs.tick);
  for (let i = 0; i < s.orders; i++) {
    if (i > 0) {
      const factor = buyFirst ? one.minus(step.div(100)) : one.plus(step.div(100));
      const nextPrice = price.mul(factor).toNearest(specs.tick, Decimal.ROUND_HALF_UP);
      if (buyFirst) price = nextPrice.lt(price) ? nextPrice : price.minus(specs.tick);
      else price = nextPrice.gt(price) ? nextPrice : price.plus(specs.tick);
    }
    if (price.lte(0)) throw new SeriesSettingsError('The buys would go down to zero. Use fewer orders or a smaller step.');
    prices.push(price);
  }
  const orders = prices.map((p, i) => ({ slot: i + 1, side: (buyFirst ? 'BUY' : 'SELL') as 'BUY' | 'SELL', price: p }));

  let qty: Decimal;
  if (buyFirst) {
    // Equal ZIG per buy, sized so all the buys together spend the chosen share of the USDT.
    const budget = startUsdt.mul(sharePct).div(100);
    qty = roundDown(budget.div(prices.reduce((n, p) => n.plus(p), new Decimal(0))), specs.lot);
  } else {
    qty = roundDown(totalZig.mul(sharePct).div(100).div(s.orders), specs.lot);
  }
  if (qty.lt(specs.lot)) throw new SeriesSettingsError(`Each order would be below the exchange minimum size. Use more ${buyFirst ? 'USDT' : 'ZIG'}, a larger share, or fewer orders.`);

  // The smallest order in the loop must still clear the exchange minimum.
  const smallest = buyFirst
    ? qty.mul(prices[prices.length - 1])
    : Decimal.min(qty.mul(prices[0]), qty.mul(buybackPrice(prices[0], buyback, specs.tick)));
  if (smallest.lt(specs.minOrderValue)) {
    const need = buyFirst
      ? specs.minOrderValue.div(prices[prices.length - 1]).mul(prices.reduce((n, p) => n.plus(p), new Decimal(0))).div(sharePct.div(100))
      : specs.minOrderValue.div(buybackPrice(prices[0], buyback, specs.tick)).mul(s.orders).div(sharePct.div(100));
    throw new SeriesSettingsError(
      `Each order is worth ${smallest.toFixed(2)} USDT, below the exchange minimum of ${specs.minOrderValue} USDT. ` +
      `With ${s.orders} orders and ${sharePct.toFixed()}% used you need about ${need.toDecimalPlaces(0, Decimal.ROUND_UP).toFixed()} ${buyFirst ? 'USDT' : 'ZIG'}, or use fewer orders or a larger share.`,
    );
  }
  const usdtForBuys = buyFirst ? prices.reduce((n, p) => n.plus(p.mul(qty)), new Decimal(0)) : new Decimal(0);
  const zigForSale = buyFirst ? new Decimal(0) : qty.mul(s.orders);
  if (zigForSale.gt(totalZig)) throw new SeriesSettingsError('The orders would sell more ZIG than you hold');
  if (usdtForBuys.gt(startUsdt)) throw new SeriesSettingsError('The orders would spend more USDT than you hold');
  return { direction, basePrice: base, qty, zigForSale, usdtForBuys, orders };
}
