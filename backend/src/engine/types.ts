import Decimal from 'decimal.js';

export type Side = 'BUY' | 'SELL';
export type RungState = 'IDLE' | 'SELL_LIVE' | 'BUY_LIVE';

/** Venue facts pulled from the exchange by the adapter, never typed into config. */
export interface VenueSpecs {
  tick: Decimal;
  lot: Decimal;
  minOrderValue: Decimal;
  makerFee: Decimal;
  /** Asset a buy's fee is taken from. 'base' means we receive slightly less than we bought. */
  buyFeeAsset: 'base' | 'quote';
  maxOpenOrders: number;
}

export interface Fill {
  fillId: string;
  clientOrderId: string;
  orderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  feeAmount: Decimal;
  feeAsset: 'base' | 'quote';
  ts: number;
  /** True for an internal netting booking: no trade reached the exchange. */
  netted?: boolean;
}

export interface OpenOrder {
  clientOrderId: string;
  orderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
  filledQty: Decimal;
}

export interface OrderUpdate {
  clientOrderId: string;
  orderId: string;
  status: 'CANCELLED' | 'REJECTED';
  /** Cumulative quantity filled on this order when it ended. */
  filledQty: Decimal;
  ts: number;
}

export interface Balances {
  base: Decimal;
  quote: Decimal;
}

export interface Book {
  bestBid: Decimal;
  bestAsk: Decimal;
  ts: number;
}

export type PlaceResult =
  | { ok: true; orderId: string }
  | {
      ok: false;
      reason: 'WOULD_CROSS' | 'RATE_LIMIT' | 'INSUFFICIENT_BALANCE' | 'INVALID' | 'PRICE_LIMIT' | 'UNAVAILABLE';
      message: string;
    };

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The Telegram/alert channel. Implementations must never include key material. */
export interface Alerter {
  send(text: string): Promise<void>;
}

export const D = (v: Decimal.Value) => new Decimal(v);
