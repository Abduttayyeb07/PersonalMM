// ── Canonical internal types — all adapters produce these ────────────────────

export const INTERNAL_SYMBOL = 'ZIG/USDT';

export type ExchangeName = 'mexc' | 'bybit' | 'kucoin' | 'gateio' | 'bitget';

export interface Ticker {
  symbol: string;
  price: number;
  priceChange: number;
  priceChangePercent: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
}

export interface OrderBookEntry {
  price: number;
  qty: number;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export interface Trade {
  id?: string;
  price: number;
  qty: number;
  time: number;
  isBuyerMaker: boolean;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';

export type OrderStatus =
  | 'NEW'
  | 'PENDING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'FAILED';

export interface Order {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  origQty: string;
  price: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: OrderStatus;
  time: number;
  updateTime: number;
}

export interface PlaceOrderParams {
  side: OrderSide;
  type: OrderType;
  quantity: string;
  price?: string;
  quoteOrderQty?: string;
  clientOrderId?: string;
}

export interface SymbolPrecision {
  exchange: ExchangeName;
  symbol: string;
  baseIncrement: string;   // step size for base qty
  quoteIncrement: string;  // tick size for price
  minBaseQty: string;      // minimum base quantity
  minQuoteQty: string;     // minimum quote (USDT) value
}
