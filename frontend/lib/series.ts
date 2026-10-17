import api from './api';

/** What the user chooses when starting a series. Numbers travel as strings to stay exact. */
/** Sell first: sells above the base, buybacks below them. Buy first (the mirror): buys below, sell-backs above. */
export type SeriesDirection = 'SELL_FIRST' | 'BUY_FIRST';

export interface SeriesSettings {
  direction?: SeriesDirection;
  totalZig: string;
  startUsdt: string;
  basePrice: string | null;
  sellPct: string;
  orders: number;
  firstSellPct: string;
  stepPct: string;
  buybackPct: string;
  resellPct: string;
  /** Every day at 00:00 Pakistan time the base moves to the last candle's close and all orders are replaced. */
  dailyReset?: boolean;
  maxCycles: number | null;
  maxHours: number | null;
}

export type OrderKind = 'FIRST_SELL' | 'BUYBACK' | 'RESELL' | 'FIRST_BUY' | 'SELLBACK' | 'REBUY';
export type SeriesStatus = 'STARTING' | 'RUNNING' | 'PAUSED' | 'HALTED' | 'STOPPED';

export interface SeriesOrder {
  slot: number;
  cycle: number;
  side: 'BUY' | 'SELL';
  kind: OrderKind;
  target: string | null;
  price: string | null;
  qty: string;
  filled: string;
  status: 'OPEN' | 'SENDING' | 'WAITING' | 'QUEUED' | 'CANCELLED';
  waiting: string | null;
  soldAt: string | null;
  boughtAt: string | null;
  zigOut: string;
  loops: number;
  loopProfit: string;
}

export interface SeriesFill {
  id: string;
  ts: string;
  slot: number;
  cycle: number;
  side: 'BUY' | 'SELL';
  kind: OrderKind;
  price: string;
  qty: string;
  value: string;
  fee: string;
  feeAsset: 'base' | 'quote';
  loopProfit: string | null;
}

export interface SeriesLoop {
  slot: number; cycle: number; qty: string; sold: string; bought: string; profit: string; openedAt: string; closedAt: string;
}

export interface SeriesDetail {
  id: string;
  label: string;
  seriesNo: number;
  direction: SeriesDirection;
  status: SeriesStatus;
  statusReason: string | null;
  startedAt: string;
  stoppedAt: string | null;
  settings: SeriesSettings;
  plan: { basePrice: string; qty: string; orders: number; firstSell: string | null };
  book: { bestBid: string; bestAsk: string } | null;
  totals: {
    profit: string; profitPerHour: string; cycles: number; sellFills: number; buyFills: number;
    openSells: number; openBuys: number; zigOut: string; usdtHeldForBuybacks: string; fees: string;
  };
  balances: { zig: string; usdt: string } | null;
  orders: SeriesOrder[];
  fills: SeriesFill[];
  loops: SeriesLoop[];
  events: Array<{ ts: string; kind: string; detail: Record<string, unknown> }>;
  breaches: string[];
  dailyReset: {
    resets: number;
    lastAt: string | null;
    nextAt: string | null;
    /** ZIG left sold (positive) or left bought (negative) by loops a reset closed early. */
    zigLeftOpen: string;
    usdtLeftOpen: string;
  } | null;
}

export interface SeriesHistoryRow {
  id: string; label: string; seriesNo: number; direction: SeriesDirection; basePrice: string; qty: string; orders: number; totalZig: string;
  startedAt: string; stoppedAt: string | null; status: 'RUNNING' | 'STOPPED'; statusReason: string | null;
  cycles: number; profit: string;
}

export interface SeriesOverview {
  running: boolean;
  defaults: SeriesSettings;
  buyFirstDefaults: SeriesSettings;
  marketPrice: string | null;
  history: SeriesHistoryRow[];
  series: SeriesDetail | null;
}

export interface SeriesPreview {
  direction: SeriesDirection;
  marketPrice: string;
  basePrice: string;
  qtyPerOrder: string;
  zigForSale: string;
  usdtForBuys: string;
  /** Opening orders; nextAt is where each loop closes (buyback below a sell, sell-back above a buy). */
  orders: Array<{ slot: number; side: 'BUY' | 'SELL'; price: string; value: string; restsAt: string; nextAt: string }>;
  waitingForMarket: number;
  loopProfit: string;
  nextPct: string;
  minOrderValue: string;
}

export const getSeries = () => api.get<SeriesOverview>('/series');
export const previewSeries = (settings: SeriesSettings) => api.post<SeriesPreview>('/series/preview', { settings });
export const startSeries = (settings: SeriesSettings) => api.post<SeriesOverview>('/series/start', { settings });
export const stopSeries = () => api.post<SeriesOverview>('/series/stop');

export const KIND_LABEL: Record<OrderKind, string> = {
  FIRST_SELL: 'First sell', BUYBACK: 'Buyback', RESELL: 'Re-sell',
  FIRST_BUY: 'First buy', SELLBACK: 'Sell-back', REBUY: 'Re-buy',
};
export const kindSide = (k: OrderKind): 'BUY' | 'SELL' => (k === 'BUYBACK' || k === 'FIRST_BUY' || k === 'REBUY' ? 'BUY' : 'SELL');

/** Words that change with the direction, so every screen reads naturally for either one. */
export function words(direction: SeriesDirection | undefined) {
  const buy = direction === 'BUY_FIRST';
  return {
    buy,
    name: buy ? 'Buy first' : 'Sell first',
    opening: buy ? 'buys' : 'sells',
    closing: buy ? 'sell-backs' : 'buybacks',
    loopLine: buy
      ? 'Buys go down from your base. Every filled buy sells back 3% higher; every filled sell-back books its profit and buys again 3% lower.'
      : 'Sells go up from your base. Every filled sell buys back 3% lower; every filled buyback books its profit and sells again 3% higher.',
  };
}

export const STATUS_INFO: Record<SeriesStatus, { label: string; color: string; help: string }> = {
  STARTING: { label: 'Starting', color: 'var(--warn)', help: 'Placing the first orders.' },
  RUNNING: { label: 'Running', color: 'var(--good)', help: 'Orders are resting on live Bybit prices.' },
  PAUSED: { label: 'Paused', color: 'var(--warn)', help: 'Market data stopped. Orders were cancelled and come back by themselves when data returns.' },
  HALTED: { label: 'Halted', color: 'var(--bad)', help: 'A safety check failed. Every order was cancelled. Start a new series to continue.' },
  STOPPED: { label: 'Stopped', color: 'var(--faint)', help: 'Every order was cancelled. Profit stays recorded.' },
};

/** Plain-language lines for the series activity log. */
export function describeSeriesEvent(e: SeriesDetail['events'][number]): { text: string; tone: 'neutral' | 'good' | 'bad' } {
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'SERIES_STARTED': {
      const buy = d.direction === 'BUY_FIRST';
      return { text: `Started ${buy ? 'buying' : 'selling'} first at base ${d.base}: ${d.orders} ${buy ? 'buys' : 'sells'} of ${Number(d.qtyPerOrder).toLocaleString('en-US')} ZIG, ${d.first ?? d.firstSell} to ${d.last ?? d.lastSell}`, tone: 'good' };
    }
    case 'SOLD': return { text: `Order #${d.slot} sold ${Number(d.qty).toLocaleString('en-US')} ZIG at ${d.at}. Buyback placed at ${d.buyAt}`, tone: 'neutral' };
    case 'BOUGHT': return { text: `Order #${d.slot} bought ${Number(d.qty).toLocaleString('en-US')} ZIG at ${d.at}. Sell-back placed at ${d.sellAt}`, tone: 'neutral' };
    case 'CYCLE': return { text: `Order #${d.slot} loop ${d.cycle} closed: sold ${Number(d.sold).toFixed(5)}, bought ${Number(d.bought).toFixed(5)}, profit $${Number(d.profit).toFixed(4)}`, tone: 'good' };
    case 'SERIES_STOPPED': {
      const sold = Number(d.zigStillSold ?? 0);
      const bought = Number(d.zigStillBought ?? 0);
      const left = sold > 0 ? `${sold.toLocaleString('en-US')} ZIG was still sold (kept as USDT).`
        : bought > 0 ? `${bought.toLocaleString('en-US')} ZIG was still bought (kept as ZIG).` : 'No loop was left open.';
      return { text: `Stopped: ${d.reason}. All orders cancelled. ${left}`, tone: 'neutral' };
    }
    case 'PAUSED': return { text: `Paused: ${d.reason}`, tone: 'bad' };
    case 'RESUMED': return { text: `Resumed after ${d.after}`, tone: 'good' };
    case 'REBASED': {
      const sold = Number(d.zigLeftSold ?? 0);
      const bought = Number(d.zigLeftBought ?? 0);
      const left = sold > 0 ? ` ${sold.toLocaleString('en-US')} ZIG stayed sold.` : bought > 0 ? ` ${bought.toLocaleString('en-US')} ZIG stayed bought.` : '';
      return { text: `Daily reset: base ${d.from} → ${d.to}. All orders replaced: ${d.orders} × ${Number(d.qtyPerOrder).toLocaleString('en-US')} ZIG, ${d.first} to ${d.last}.${Number(d.loopsClosedEarly) > 0 ? ` ${d.loopsClosedEarly} open loops closed early.` : ''}${left}`, tone: 'neutral' };
    }
    case 'HALTED': return { text: `Halted: ${d.reason}`, tone: 'bad' };
    case 'LEASE_LOST': return { text: 'Another instance took over this series', tone: 'bad' };
    default: return { text: e.kind.toLowerCase().replace(/_/g, ' '), tone: 'neutral' };
  }
}

/** Series 1 = A, 26 = Z, 27 = AA (same as the backend). */
export function seriesLabelFor(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s || 'A';
}
