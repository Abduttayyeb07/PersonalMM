import Decimal from 'decimal.js';
import { LiveOrder } from '../engine/rung-accounting';

/** What a user chooses when starting a series. Numbers travel as strings to stay exact. */
export interface SeriesSettings {
  /** All the base asset (ZIG) the simulated or real account holds. */
  totalZig: string;
  startUsdt: string;
  /** Reference price. null = the current market price when the series starts. Nothing trades at it. */
  basePrice: string | null;
  /** Percent of totalZig put up for sale across all orders (e.g. 10). */
  sellPct: string;
  /** Number of sell orders placed at the start (e.g. 15). */
  orders: number;
  /** First sell sits this far above the base (e.g. 3). */
  firstSellPct: string;
  /** Each following sell sits this far above the previous one (e.g. 1). */
  stepPct: string;
  /** After a sell fills, the buyback goes this far below it (e.g. 3). */
  buybackPct: string;
  /** After a buyback fills, the re-sell goes this far above it (e.g. 3). */
  resellPct: string;
  /** Optional automatic stop. */
  maxCycles: number | null;
  maxHours: number | null;
}

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
}

export interface PlannedOrder {
  slot: number;
  sellPrice: Decimal;
}

export interface SeriesPlan {
  basePrice: Decimal;
  qty: Decimal;
  zigForSale: Decimal;
  orders: PlannedOrder[];
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
