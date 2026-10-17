import Decimal from 'decimal.js';
import { LiveOrder } from '../engine/rung-accounting';

/**
 * SELL_FIRST: sells sit above the base; each filled sell buys back lower, each buyback re-sells higher.
 * BUY_FIRST (the mirror): buys sit below the base; each filled buy sells back higher, each sell-back
 * re-buys lower. Profit is booked in USDT either way.
 */
export type SeriesDirection = 'SELL_FIRST' | 'BUY_FIRST';

/** What a user chooses when starting a series. Numbers travel as strings to stay exact. */
export interface SeriesSettings {
  /** Which side opens each loop. Missing on series stored before buy-first existed: SELL_FIRST. */
  direction?: SeriesDirection;
  /** All the base asset (ZIG) the simulated or real account holds. Funds the sells when selling first. */
  totalZig: string;
  /** USDT the account holds. Funds the buys when buying first. */
  startUsdt: string;
  /** Reference price. null = the current market price when the series starts. Nothing trades at it. */
  basePrice: string | null;
  /** Percent of the funding asset put into the opening orders (ZIG when selling first, USDT when buying first). */
  sellPct: string;
  /** Number of opening orders placed at the start (e.g. 15). */
  orders: number;
  /** First opening order sits this far from the base: above it when selling first, below when buying first. */
  firstSellPct: string;
  /** Each following opening order sits this far beyond the previous one (e.g. 1). */
  stepPct: string;
  /** Distance below a filled sell for the next buy: the buyback (sell first) or the re-buy (buy first). */
  buybackPct: string;
  /** Distance above a filled buy for the next sell: the re-sell (sell first) or the sell-back (buy first). */
  resellPct: string;
  /**
   * Every day at 00:00 Pakistan time (19:00 UTC) the base moves to the last 1-minute candle's close,
   * every order is cancelled (open loops included) and a fresh ladder is placed. Same series.
   */
  dailyReset?: boolean;
  /** Optional automatic stop. */
  maxCycles: number | null;
  maxHours: number | null;
}

export const directionOf = (s: Pick<SeriesSettings, 'direction'>): SeriesDirection => s.direction ?? 'SELL_FIRST';

export type SlotState = 'SELL_LIVE' | 'BUY_LIVE';

/** One order's loop: sell -> buyback -> re-sell -> buyback ... */
export interface Slot {
  slot: number;
  state: SlotState;
  cycle: number;
  /** Base asset sold in each cycle of this slot. */
  qty: Decimal;
  /** Price this slot's current sell is aimed at. */
  sellTarget: Decimal;
  /** Price this slot's current buyback is aimed at (set once the sell has filled). */
  buyTarget: Decimal | null;
  legQty: Decimal;
  legFilled: Decimal;
  revision: number;
  order: LiveOrder | null;
  waiting?: string;
  // Accumulators for the cycle in progress.
  soldQty: Decimal;
  soldQuote: Decimal; // proceeds net of the sell fee
  feeSellQuote: Decimal;
  boughtGross: Decimal;
  boughtNet: Decimal;
  buyCost: Decimal;
  feeBuyQuote: Decimal;
  openedAt: number;
}

export interface SeriesCycle {
  slot: number;
  cycle: number;
  soldQty: Decimal;
  avgSell: Decimal;
  avgBuy: Decimal;
  soldQuote: Decimal;
  boughtGross: Decimal;
  boughtNet: Decimal;
  buyCost: Decimal;
  feeSellQuote: Decimal;
  feeBuyQuote: Decimal;
  profit: Decimal;
  openedAt: number;
  closedAt: number;
}

export interface SeriesRun {
  id: string;
  ownerId: string;
  mode: 'paper' | 'backtest';
  seriesNo: number;
  settings: SeriesSettings;
  basePrice: Decimal;
  qty: Decimal;
  startZig: Decimal;
  startUsdt: Decimal;
  status: 'RUNNING' | 'STOPPED';
  statusReason: string | null;
  startedAt: number;
  stoppedAt: number | null;
  /** When the ladder was last moved to a new base by the daily reset (null: never). */
  lastResetAt?: number | null;
  resets?: number;
  /**
   * Base and quote left changed by loops that a reset closed early: ZIG sold and not bought back is
   * negative base and positive quote. Kept so the balance checks still add up.
   */
  carriedBase?: Decimal;
  carriedQuote?: Decimal;
}

export interface PlannedOrder {
  slot: number;
  /** The opening side: SELL when selling first, BUY when buying first. */
  side: 'BUY' | 'SELL';
  price: Decimal;
}

export interface SeriesPlan {
  direction: SeriesDirection;
  basePrice: Decimal;
  qty: Decimal;
  /** ZIG the opening sells need (selling first; 0 when buying first). */
  zigForSale: Decimal;
  /** USDT the opening buys need (buying first; 0 when selling first). */
  usdtForBuys: Decimal;
  orders: PlannedOrder[];
}

/** What an order is for, in the user's words. */
export type OrderKind = 'FIRST_SELL' | 'BUYBACK' | 'RESELL' | 'FIRST_BUY' | 'SELLBACK' | 'REBUY';

export function orderKind(direction: SeriesDirection, side: 'BUY' | 'SELL', cycle: number): OrderKind {
  if (direction === 'BUY_FIRST') return side === 'SELL' ? 'SELLBACK' : cycle > 1 ? 'REBUY' : 'FIRST_BUY';
  return side === 'BUY' ? 'BUYBACK' : cycle > 1 ? 'RESELL' : 'FIRST_SELL';
}

/** "Series A", "Series B" ... "Series Z", "Series AA". */
export function seriesLabel(n: number): string {
  let s = '';
  let k = n;
  while (k > 0) {
    const r = (k - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s || '?';
}
