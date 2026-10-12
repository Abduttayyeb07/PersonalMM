import Decimal from 'decimal.js';
import { PairConfig } from './config/engine-config';
import { VenueSpecs } from './types';

export interface LatticeRung {
  /** Stable key, e.g. "A+01" or "B-06". */
  key: string;
  ladder: string;
  n: number;
  /** Exact (unrounded) price L(n). */
  exactSell: Decimal;
  /** Sell price rounded UP to the tick. */
  sellPrice: Decimal;
  /** Buyback price L(n-1) rounded DOWN to the tick: the hard cap for the buy. */
  buyPrice: Decimal;
}

export function rungKey(ladder: string, n: number): string {
  return `${ladder}${n < 0 ? '-' : '+'}${String(Math.abs(n)).padStart(2, '0')}`;
}

export const roundUp = (v: Decimal, tick: Decimal) => v.div(tick).ceil().mul(tick);
export const roundDown = (v: Decimal, tick: Decimal) => v.div(tick).floor().mul(tick);

/** L(n) = P0 * (1 + step)^n * (1 + offset). */
export function exactPrice(cfg: PairConfig, offset: Decimal, n: number): Decimal {
  return cfg.basePrice.mul(new Decimal(1).plus(cfg.step).pow(n)).mul(new Decimal(1).plus(offset));
}

/**
 * Builds every rung from config. A rung exists when its SELL price lies inside [floor, top].
 * Its buyback target L(n-1) is one step lower in the same ladder and may sit just under the floor
 * for the lowest rung; the floor/top bound applies to what is sold.
 */
export function buildLattice(cfg: PairConfig, specs: Pick<VenueSpecs, 'tick'>): LatticeRung[] {
  const rungs: LatticeRung[] = [];
  const maxN = 400;
  for (const ladder of cfg.ladders) {
    for (let n = -maxN; n <= maxN; n++) {
      const exact = exactPrice(cfg, ladder.offset, n);
      const sellPrice = roundUp(exact, specs.tick);
      if (sellPrice.lt(cfg.floorPrice) || sellPrice.gt(cfg.topPrice)) continue;
      const buyPrice = roundDown(exactPrice(cfg, ladder.offset, n - 1), specs.tick);
      rungs.push({ key: rungKey(ladder.name, n), ladder: ladder.name, n, exactSell: exact, sellPrice, buyPrice });
    }
  }
  return rungs.sort((a, b) => a.sellPrice.comparedTo(b.sellPrice));
}

/** Net profit of one completed cycle: q*(sell-buy) minus the fee on each side, in quote. */
export function cycleProfit(q: Decimal, sell: Decimal, buy: Decimal, fee: Decimal): Decimal {
  return q.mul(sell.minus(buy)).minus(fee.mul(q).mul(sell)).minus(fee.mul(q).mul(buy));
}
