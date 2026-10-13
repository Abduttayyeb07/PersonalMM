import api from './api';

/** What the user chooses when starting a series. Numbers travel as strings to stay exact. */
export interface SeriesSettings {
  totalZig: string;
  startUsdt: string;
  basePrice: string | null;
  sellPct: string;
  orders: number;
  firstSellPct: string;
  stepPct: string;
  buybackPct: string;
  resellPct: string;
  maxCycles: number | null;
  maxHours: number | null;
}

export type OrderKind = 'FIRST_SELL' | 'BUYBACK' | 'RESELL';
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
}

export interface SeriesHistoryRow {
  id: string; label: string; seriesNo: number; basePrice: string; qty: string; orders: number; totalZig: string;
  startedAt: string; stoppedAt: string | null; status: 'RUNNING' | 'STOPPED'; statusReason: string | null;
  cycles: number; profit: string;
}

export interface SeriesOverview {
  running: boolean;
  defaults: SeriesSettings;
  marketPrice: string | null;
  history: SeriesHistoryRow[];
  series: SeriesDetail | null;
}

export interface SeriesPreview {
  marketPrice: string;
  basePrice: string;
  qtyPerOrder: string;
  zigForSale: string;
  orders: Array<{ slot: number; sellPrice: string; value: string; restsAt: string; buybackAt: string }>;
  aboveMarket: number;
  loopProfit: string;
  resellPct: string;
  minOrderValue: string;
}

export const getSeries = () => api.get<SeriesOverview>('/series');
export const previewSeries = (settings: SeriesSettings) => api.post<SeriesPreview>('/series/preview', { settings });
export const startSeries = (settings: SeriesSettings) => api.post<SeriesOverview>('/series/start', { settings });
export const stopSeries = () => api.post<SeriesOverview>('/series/stop');

export const KIND_LABEL: Record<OrderKind, string> = { FIRST_SELL: 'First sell', BUYBACK: 'Buyback', RESELL: 'Re-sell' };

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
    case 'SERIES_STARTED': return { text: `Started at base ${d.base}: ${d.orders} sells of ${Number(d.qtyPerOrder).toLocaleString('en-US')} ZIG, ${d.firstSell} to ${d.lastSell}`, tone: 'good' };
    case 'SOLD': return { text: `Order #${d.slot} sold ${Number(d.qty).toLocaleString('en-US')} ZIG at ${d.at}. Buyback placed at ${d.buyAt}`, tone: 'neutral' };
    case 'CYCLE': return { text: `Order #${d.slot} loop ${d.cycle} closed: sold ${Number(d.sold).toFixed(5)}, bought ${Number(d.bought).toFixed(5)}, profit $${Number(d.profit).toFixed(4)}`, tone: 'good' };
    case 'SERIES_STOPPED': return { text: `Stopped: ${d.reason}. All orders cancelled. ${Number(d.zigStillSold) > 0 ? `${Number(d.zigStillSold).toLocaleString('en-US')} ZIG was still sold.` : 'No ZIG left sold.'}`, tone: 'neutral' };
    case 'PAUSED': return { text: `Paused: ${d.reason}`, tone: 'bad' };
    case 'RESUMED': return { text: `Resumed after ${d.after}`, tone: 'good' };
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
