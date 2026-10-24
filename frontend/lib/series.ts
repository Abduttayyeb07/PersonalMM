import api from './api';

/** What the user chooses when starting a series. Numbers travel as strings to stay exact. */
/** Sell first: sells above the base, buybacks below them. Buy first (the mirror): buys below, sell-backs above. */
export type SeriesDirection = 'SELL_FIRST' | 'BUY_FIRST';

/** Bybit spot pairs a simulation can trade, all against USDT. */
export type SeriesSymbol = 'ZIGUSDT' | 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT' | 'UNIUSDT' | 'ONDOUSDT' | 'CAKEUSDT' | 'TAOUSDT';

/** Exchange whose live prices a simulation follows. */
export type SeriesVenue = 'BYBIT' | 'MEXC';
export const VENUES: Array<{ id: SeriesVenue; name: string }> = [{ id: 'BYBIT', name: 'Bybit' }, { id: 'MEXC', name: 'MEXC' }];
export const venueName = (v: SeriesVenue | undefined) => (v === 'MEXC' ? 'MEXC' : 'Bybit');
export const otherVenue = (v: SeriesVenue | undefined): SeriesVenue => (v === 'MEXC' ? 'BYBIT' : 'MEXC');

export const PAIRS: Record<SeriesSymbol, { asset: string; label: string; priceDp: number; amountDp: number }> = {
  ZIGUSDT: { asset: 'ZIG', label: 'ZIG/USDT', priceDp: 5, amountDp: 2 },
  BTCUSDT: { asset: 'BTC', label: 'BTC/USDT', priceDp: 1, amountDp: 6 },
  ETHUSDT: { asset: 'ETH', label: 'ETH/USDT', priceDp: 2, amountDp: 5 },
  SOLUSDT: { asset: 'SOL', label: 'SOL/USDT', priceDp: 2, amountDp: 4 },
  UNIUSDT: { asset: 'UNI', label: 'UNI/USDT', priceDp: 3, amountDp: 2 },
  ONDOUSDT: { asset: 'ONDO', label: 'ONDO/USDT', priceDp: 4, amountDp: 2 },
  CAKEUSDT: { asset: 'CAKE', label: 'CAKE/USDT', priceDp: 4, amountDp: 3 },
  TAOUSDT: { asset: 'TAO', label: 'TAO/USDT', priceDp: 2, amountDp: 3 },
};

/** Number formatting for one pair: prices to its tick, amounts to its lot. */
export function pairFmt(symbol: SeriesSymbol | undefined) {
  const p = PAIRS[symbol ?? 'ZIGUSDT'] ?? PAIRS.ZIGUSDT;
  return {
    asset: p.asset,
    label: p.label,
    price: (v: string | number) => Number(v).toLocaleString('en-US', { minimumFractionDigits: p.priceDp, maximumFractionDigits: p.priceDp }),
    amount: (v: string | number) => {
      const n = Number(v);
      // Big ZIG amounts read best whole; BTC keeps its decimals.
      const dp = p.amountDp <= 2 && Math.abs(n) >= 100 ? 0 : p.amountDp;
      return n.toLocaleString('en-US', { maximumFractionDigits: dp });
    },
  };
}
export type PairFmt = ReturnType<typeof pairFmt>;

export interface SeriesSettings {
  symbol?: SeriesSymbol;
  venue?: SeriesVenue;
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
  mode: SeriesMode;
  symbol: SeriesSymbol;
  venue: SeriesVenue;
  asset: string;
  /** In memory and trading now. */
  running: boolean;
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

/** One simulation as a tab or a history row shows it. */
export interface SeriesRunSummary {
  id: string; label: string; seriesNo: number; mode: SeriesMode; symbol: SeriesSymbol; venue: SeriesVenue; asset: string; direction: SeriesDirection;
  basePrice: string; qty: string; orders: number; totalZig: string; startUsdt: string; dailyReset: boolean;
  startedAt: string; stoppedAt: string | null;
  status: SeriesStatus; statusReason: string | null; live: boolean; openOrders: number;
  cycles: number; profit: string;
}

/** What the API returns: every simulation of the user, and each exchange's pairs, limits and totals. */
export interface SeriesOverviewResponse {
  runs: SeriesRunSummary[];
  venues: Array<{
    venue: SeriesVenue; running: number; maxRunning: number; totalProfit: string; runningProfit: string;
    pairs: Array<{ symbol: SeriesSymbol; asset: string }>;
    defaults: Record<string, Record<SeriesDirection, SeriesSettings>>;
  }>;
  /** Last prices keyed "BYBIT:ZIGUSDT". */
  markets: Record<string, string | null>;
  live: LiveInfo;
}

/** Paper: simulated fills with a paper wallet. Live: real orders on the user's own MEXC account. */
export type SeriesMode = 'paper' | 'live';

/** What real-money trading allows for this user right now. */
export interface LiveInfo {
  venues: SeriesVenue[];
  symbols: SeriesSymbol[];
  /** Most a live wallet may be worth, in USDT. */
  maxUsdt: string;
  hasMexcKey: boolean;
  running: number;
  totalProfit: string;
}

/** One exchange's slice of the overview: its simulations, pairs, prices, limit and totals. */
export interface SeriesOverview {
  venue: SeriesVenue;
  runs: SeriesRunSummary[];
  running: number;
  maxRunning: number;
  totalProfit: string;
  runningProfit: string;
  pairs: Array<{ symbol: SeriesSymbol; asset: string }>;
  /** Last prices on this exchange, by symbol. */
  markets: Record<string, string | null>;
  defaults: Record<string, Record<SeriesDirection, SeriesSettings>>;
  live: LiveInfo;
}

export function venueView(o: SeriesOverviewResponse, venue: SeriesVenue): SeriesOverview {
  const v = o.venues.find((x) => x.venue === venue) ?? o.venues[0];
  const markets: Record<string, string | null> = {};
  for (const [key, price] of Object.entries(o.markets)) {
    const [ex, sym] = key.split(':');
    if (ex === v.venue) markets[sym] = price;
  }
  return { ...v, runs: o.runs.filter((r) => (r.venue ?? 'BYBIT') === v.venue), markets, live: o.live };
}

export interface SeriesPreview {
  symbol: SeriesSymbol;
  venue: SeriesVenue;
  makerFeePct: string;
  asset: string;
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

export const getSeries = () => api.get<SeriesOverviewResponse>('/series');
/** Real money on the user's MEXC account. Needs the account password again. */
export const startLiveSeries = (settings: SeriesSettings, accountPassword: string) =>
  api.post<SeriesOverviewResponse & { id: string }>('/series/start-live', { settings, accountPassword });
export const getSeriesDetail = (id: string) => api.get<SeriesDetail>(`/series/${id}`);
export const previewSeries = (settings: SeriesSettings) => api.post<SeriesPreview>('/series/preview', { settings });
export const startSeries = (settings: SeriesSettings) => api.post<SeriesOverviewResponse & { id: string }>('/series/start', { settings });
export const stopSeries = (id: string) => api.post<SeriesOverviewResponse>(`/series/${id}/stop`);
/** Starts the same simulation (same settings and base price) on the other exchange. */
export const copySeries = (id: string, venue: SeriesVenue) => api.post<SeriesOverviewResponse & { id: string }>(`/series/${id}/copy`, { venue });

export const KIND_LABEL: Record<OrderKind, string> = {
  FIRST_SELL: 'First sell', BUYBACK: 'Buyback', RESELL: 'Re-sell',
  FIRST_BUY: 'First buy', SELLBACK: 'Sell-back', REBUY: 'Re-buy',
};
export const kindSide = (k: OrderKind): 'BUY' | 'SELL' => (k === 'BUYBACK' || k === 'FIRST_BUY' || k === 'REBUY' ? 'BUY' : 'SELL');

/** Words that change with the direction, so every screen reads naturally for either one. */
export function words(direction: SeriesDirection | undefined, asset = 'ZIG') {
  const buy = direction === 'BUY_FIRST';
  return {
    asset,
    buy,
    name: buy ? 'Buy first' : 'Sell first',
    opening: buy ? 'buys' : 'sells',
    closing: buy ? 'sell-backs' : 'buybacks',
    loopLine: buy
      ? `Buys go down from your base. Every filled buy sells its ${asset} back higher; every filled sell-back books its profit and buys again lower.`
      : `Sells go up from your base. Every filled sell buys the ${asset} back lower; every filled buyback books its profit and sells again higher.`,
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
export function describeSeriesEvent(e: SeriesDetail['events'][number], asset = 'ZIG'): { text: string; tone: 'neutral' | 'good' | 'bad' } {
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'SERIES_STARTED': {
      const buy = d.direction === 'BUY_FIRST';
      return { text: `Started ${buy ? 'buying' : 'selling'} first at base ${d.base}: ${d.orders} ${buy ? 'buys' : 'sells'} of ${Number(d.qtyPerOrder).toLocaleString('en-US')} ${asset}, ${d.first ?? d.firstSell} to ${d.last ?? d.lastSell}`, tone: 'good' };
    }
    case 'SOLD': return { text: `Order #${d.slot} sold ${Number(d.qty).toLocaleString('en-US')} ${asset} at ${d.at}. Buyback placed at ${d.buyAt}`, tone: 'neutral' };
    case 'BOUGHT': return { text: `Order #${d.slot} bought ${Number(d.qty).toLocaleString('en-US')} ${asset} at ${d.at}. Sell-back placed at ${d.sellAt}`, tone: 'neutral' };
    case 'CYCLE': return { text: `Order #${d.slot} loop ${d.cycle} closed: sold ${Number(d.sold).toFixed(5)}, bought ${Number(d.bought).toFixed(5)}, profit $${Number(d.profit).toFixed(4)}`, tone: 'good' };
    case 'SERIES_STOPPED': {
      const sold = Number(d.zigStillSold ?? 0);
      const bought = Number(d.zigStillBought ?? 0);
      const left = sold > 0 ? `${sold.toLocaleString('en-US')} ${asset} was still sold (kept as USDT).`
        : bought > 0 ? `${bought.toLocaleString('en-US')} ${asset} was still bought (kept as ${asset}).` : 'No loop was left open.';
      return { text: `Stopped: ${d.reason}. All orders cancelled. ${left}`, tone: 'neutral' };
    }
    case 'PAUSED': return { text: `Paused: ${d.reason}`, tone: 'bad' };
    case 'RESUMED': return { text: `Resumed after ${d.after}`, tone: 'good' };
    case 'REBASED': {
      const sold = Number(d.zigLeftSold ?? 0);
      const bought = Number(d.zigLeftBought ?? 0);
      const left = sold > 0 ? ` ${sold.toLocaleString('en-US')} ${asset} stayed sold.` : bought > 0 ? ` ${bought.toLocaleString('en-US')} ${asset} stayed bought.` : '';
      return { text: `Daily reset: base ${d.from} → ${d.to}. All orders replaced: ${d.orders} × ${Number(d.qtyPerOrder).toLocaleString('en-US')} ${asset}, ${d.first} to ${d.last}.${Number(d.loopsClosedEarly) > 0 ? ` ${d.loopsClosedEarly} open loops closed early.` : ''}${left}`, tone: 'neutral' };
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
