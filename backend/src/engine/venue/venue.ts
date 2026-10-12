import Decimal from 'decimal.js';
import { Balances, Book, Fill, OpenOrder, OrderUpdate, PlaceResult, Side, VenueSpecs } from '../types';

export interface PlaceRequest {
  clientOrderId: string;
  side: Side;
  price: Decimal;
  qty: Decimal;
}

export interface VenueHandlers {
  onBook(book: Book): Promise<void> | void;
  onFill(fill: Fill): Promise<void> | void;
  onOrderUpdate(update: OrderUpdate): Promise<void> | void;
  /** Called when the market or private feed connects or drops. */
  onFeedStatus(feed: 'market' | 'private', connected: boolean): Promise<void> | void;
}

/**
 * The only way the engine touches an exchange. Real venues and the simulator implement the same
 * interface, so what is tested is exactly what trades. Every order is post-only: we are always maker.
 */
export interface VenueAdapter {
  readonly name: string;
  getSpecs(): Promise<VenueSpecs>;
  placeOrder(req: PlaceRequest): Promise<PlaceResult>;
  /** Asynchronous: the result arrives as an OrderUpdate. Cancelling an unknown order is not an error. */
  cancelOrder(clientOrderId: string): Promise<void>;
  cancelAll(): Promise<void>;
  getOpenOrders(): Promise<OpenOrder[]>;
  /** Order lookup by client ID, used before any retry so an order is never placed twice. */
  findOrder(clientOrderId: string): Promise<{ found: boolean; open?: OpenOrder; cancelled?: boolean; filledQty?: Decimal }>;
  getFillsSince(ts: number): Promise<Fill[]>;
  getBalances(): Promise<Balances>;
  getBook(): Promise<Book>;
  /** Starts the feeds. Returns a function that stops them. */
  start(handlers: VenueHandlers): Promise<() => Promise<void>>;
}
