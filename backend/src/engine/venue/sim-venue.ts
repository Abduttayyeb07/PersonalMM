import Decimal from 'decimal.js';
import { roundDown } from '../lattice';
import { Balances, Book, Clock, Fill, OpenOrder, OrderUpdate, PlaceResult, VenueSpecs } from '../types';
import { PlaceRequest, VenueAdapter, VenueHandlers } from './venue';

interface SimOrder {
  clientOrderId: string;
  orderId: string;
  side: 'BUY' | 'SELL';
  price: Decimal;
  qty: Decimal;
  filled: Decimal;
  status: 'OPEN' | 'CANCELLED' | 'FILLED';
}

/** Everything that happened on the simulated venue, for an independent auditor. */
export type VenueLogEntry =
  | { t: number; kind: 'place'; id: string; side: 'BUY' | 'SELL'; price: Decimal; qty: Decimal; ok: boolean; reason?: string; market: Decimal }
  | { t: number; kind: 'cancel'; id: string; filled: Decimal; market: Decimal }
  | { t: number; kind: 'fill'; id: string; side: 'BUY' | 'SELL'; price: Decimal; qty: Decimal; feeAmount: Decimal; feeAsset: 'base' | 'quote'; market: Decimal };

type Event =
  | { kind: 'book'; book: Book }
  | { kind: 'fill'; fill: Fill }
  | { kind: 'update'; update: OrderUpdate };

export interface SimOptions {
  specs: VenueSpecs;
  clock: Clock;
  startBase: Decimal;
  startQuote: Decimal;
  startPrice: Decimal;
  /** Gap between best bid and best ask from other traders, in ticks. */
  spreadTicks?: number;
  /** Optional partial-fill model for tests: returns the quantity to fill when an order is crossed. */
  partialFill?: (order: { clientOrderId: string; remaining: Decimal }) => Decimal;
  /** Whether the published book shows our own resting orders (true on a real exchange). Tests can turn
   * this off to model a lagging public feed. */
  ownOrdersInBook?: boolean;
}

/**
 * Simulated venue. Implements the same interface as the real adapter so backtests, shadow runs and
 * tests exercise the exact engine code that trades. Fills happen when the price trades strictly
 * through a resting order. Events are queued and delivered by drain(), never re-entrantly.
 */
export class SimVenue implements VenueAdapter {
  readonly name = 'sim';
  private price: Decimal;
  private readonly orders = new Map<string, SimOrder>();
  private base: Decimal;
  private quote: Decimal;
  private readonly fills: Fill[] = [];
  private readonly outbox: Event[] = [];
  private handlers: VenueHandlers | null = null;
  private seq = 0;
  // Failure injection for drills.
  readonly log: VenueLogEntry[] = [];
  rateLimitNext = 0;
  unavailable = false;
  /** When true, fills are not pushed to the private feed (they are still visible via REST). */
  dropPrivateFeed = false;

  constructor(private readonly o: SimOptions) {
    this.price = o.startPrice;
    this.base = o.startBase;
    this.quote = o.startQuote;
  }

  get lastPrice() { return this.price; }
  get allFills() { return [...this.fills]; }

  async getSpecs() { return this.o.specs; }

  /** Market bid/ask from other traders, ignoring our own orders. */
  private marketBidAsk() {
    const tick = this.o.specs.tick;
    const bid = roundDown(this.price, tick);
    return { bid, ask: bid.plus(tick.mul(this.o.spreadTicks ?? 1)) };
  }

  /** The book as an exchange shows it: our own resting orders can be the best price. */
  currentBook(): Book {
    let { bid, ask } = this.marketBidAsk();
    if (this.o.ownOrdersInBook === false) return { bestBid: bid, bestAsk: ask, ts: this.o.clock.now() };
    for (const o of this.orders.values()) {
      if (o.status !== 'OPEN') continue;
      if (o.side === 'SELL' && o.price.lt(ask)) ask = o.price;
      if (o.side === 'BUY' && o.price.gt(bid)) bid = o.price;
    }
    return { bestBid: bid, bestAsk: ask, ts: this.o.clock.now() };
  }

  private lockedBase() {
    let sum = new Decimal(0);
    for (const o of this.orders.values()) if (o.status === 'OPEN' && o.side === 'SELL') sum = sum.plus(o.qty.minus(o.filled));
    return sum;
  }

  private lockedQuote() {
    let sum = new Decimal(0);
    for (const o of this.orders.values()) if (o.status === 'OPEN' && o.side === 'BUY') sum = sum.plus(o.price.mul(o.qty.minus(o.filled)));
    return sum;
  }

  async placeOrder(req: PlaceRequest): Promise<PlaceResult> {
    const res = await this.placeOrderInner(req);
    this.log.push({
      t: this.o.clock.now(), kind: 'place', id: req.clientOrderId, side: req.side, price: req.price, qty: req.qty,
      ok: res.ok, reason: res.ok ? undefined : res.reason, market: this.price,
    });
    return res;
  }

  private async placeOrderInner(req: PlaceRequest): Promise<PlaceResult> {
    if (this.unavailable) return { ok: false, reason: 'UNAVAILABLE', message: 'sim venue unavailable' };
    if (this.rateLimitNext > 0) {
      this.rateLimitNext -= 1;
      return { ok: false, reason: 'RATE_LIMIT', message: 'sim rate limit' };
    }
    if ([...this.orders.values()].some((o) => o.clientOrderId === req.clientOrderId)) {
      return { ok: false, reason: 'INVALID', message: 'duplicate client order id' };
    }
    const { tick, lot, minOrderValue } = this.o.specs;
    if (!req.price.div(tick).isInteger() || !req.qty.div(lot).isInteger() || req.price.mul(req.qty).lt(minOrderValue)) {
      return { ok: false, reason: 'INVALID', message: 'tick, lot or minimum order value' };
    }
    const { bid, ask } = this.marketBidAsk();
    if ((req.side === 'SELL' && req.price.lte(bid)) || (req.side === 'BUY' && req.price.gte(ask))) {
      return { ok: false, reason: 'WOULD_CROSS', message: 'post-only order would take liquidity' };
    }
    // Self-trade prevention backstop: never rest across our own order.
    for (const o of this.orders.values()) {
      if (o.status !== 'OPEN') continue;
      if ((req.side === 'SELL' && o.side === 'BUY' && req.price.lte(o.price)) || (req.side === 'BUY' && o.side === 'SELL' && req.price.gte(o.price))) {
        return { ok: false, reason: 'INVALID', message: 'self-trade prevention' };
      }
    }
    if (req.side === 'SELL' && this.base.minus(this.lockedBase()).lt(req.qty)) {
      return { ok: false, reason: 'INSUFFICIENT_BALANCE', message: 'base' };
    }
    if (req.side === 'BUY' && this.quote.minus(this.lockedQuote()).lt(req.price.mul(req.qty))) {
      return { ok: false, reason: 'INSUFFICIENT_BALANCE', message: 'quote' };
    }
    const orderId = `sim-${++this.seq}`;
    this.orders.set(req.clientOrderId, {
      clientOrderId: req.clientOrderId, orderId, side: req.side, price: req.price, qty: req.qty, filled: new Decimal(0), status: 'OPEN',
    });
    this.outbox.push({ kind: 'book', book: this.currentBook() });
    return { ok: true, orderId };
  }

  async cancelOrder(clientOrderId: string) {
    const o = this.orders.get(clientOrderId);
    if (!o || o.status !== 'OPEN') return;
    o.status = 'CANCELLED';
    this.log.push({ t: this.o.clock.now(), kind: 'cancel', id: clientOrderId, filled: o.filled, market: this.price });
    this.outbox.push({
      kind: 'update',
      update: { clientOrderId, orderId: o.orderId, status: 'CANCELLED', filledQty: o.filled, ts: this.o.clock.now() },
    });
  }

  async cancelAll() {
    for (const o of this.orders.values()) if (o.status === 'OPEN') await this.cancelOrder(o.clientOrderId);
  }

  /** Test hook: someone cancels our order outside the engine. */
  externalCancel(clientOrderId: string) { return this.cancelOrder(clientOrderId); }

  async getOpenOrders(): Promise<OpenOrder[]> {
    if (this.unavailable) throw new Error('sim venue unavailable');
    return [...this.orders.values()].filter((o) => o.status === 'OPEN').map((o) => ({
      clientOrderId: o.clientOrderId, orderId: o.orderId, side: o.side, price: o.price, qty: o.qty, filledQty: o.filled,
    }));
  }

  async findOrder(clientOrderId: string) {
    const o = this.orders.get(clientOrderId);
    if (!o) return { found: false };
    return {
      found: true,
      cancelled: o.status === 'CANCELLED',
      filledQty: o.filled,
      open: o.status === 'OPEN'
        ? { clientOrderId, orderId: o.orderId, side: o.side, price: o.price, qty: o.qty, filledQty: o.filled }
        : undefined,
    };
  }

  async getFillsSince(ts: number) { return this.fills.filter((f) => f.ts >= ts); }
  async getBalances(): Promise<Balances> { return { base: this.base, quote: this.quote }; }
  async getBook() { return this.currentBook(); }

  async start(handlers: VenueHandlers) {
    this.handlers = handlers;
    return async () => { this.handlers = null; };
  }

  /** Test hook: forget the live handlers (simulates a crashed engine process). */
  detach() { this.handlers = null; }

  /** Delivers queued events one at a time; handlers may enqueue more. */
  async drain() {
    while (this.outbox.length) {
      const e = this.outbox.shift()!;
      const h = this.handlers;
      if (!h) continue;
      if (e.kind === 'book') await h.onBook(e.book);
      else if (e.kind === 'fill') { if (!this.dropPrivateFeed) await h.onFill(e.fill); }
      else await h.onOrderUpdate(e.update);
    }
  }

  private fillOrder(o: SimOrder) {
    const remaining = o.qty.minus(o.filled);
    const qty = this.o.partialFill ? Decimal.min(remaining, this.o.partialFill({ clientOrderId: o.clientOrderId, remaining })) : remaining;
    if (!qty.isPositive()) return;
    const fee = this.o.specs.makerFee;
    let feeAmount: Decimal;
    let feeAsset: 'base' | 'quote';
    if (o.side === 'SELL') {
      feeAmount = o.price.mul(qty).mul(fee);
      feeAsset = 'quote';
      this.base = this.base.minus(qty);
      this.quote = this.quote.plus(o.price.mul(qty)).minus(feeAmount);
    } else if (this.o.specs.buyFeeAsset === 'base') {
      feeAmount = qty.mul(fee);
      feeAsset = 'base';
      this.base = this.base.plus(qty).minus(feeAmount);
      this.quote = this.quote.minus(o.price.mul(qty));
    } else {
      feeAmount = o.price.mul(qty).mul(fee);
      feeAsset = 'quote';
      this.base = this.base.plus(qty);
      this.quote = this.quote.minus(o.price.mul(qty)).minus(feeAmount);
    }
    o.filled = o.filled.plus(qty);
    if (o.filled.gte(o.qty)) o.status = 'FILLED';
    const fill: Fill = {
      fillId: `sim-fill-${++this.seq}`, clientOrderId: o.clientOrderId, orderId: o.orderId, side: o.side,
      price: o.price, qty, feeAmount, feeAsset, ts: this.o.clock.now(),
    };
    this.fills.push(fill);
    this.log.push({ t: fill.ts, kind: 'fill', id: o.clientOrderId, side: o.side, price: o.price, qty, feeAmount, feeAsset, market: this.price });
    this.outbox.push({ kind: 'fill', fill });
  }

  /**
   * Moves the market to `target`, filling resting orders the price trades strictly through, in
   * price order. The engine reacts to each fill before the price moves on.
   */
  async moveTo(target: Decimal) {
    const touched = new Set<string>(); // an order is crossed at most once per move
    for (let guard = 0; guard < 10_000; guard++) {
      const up = target.gt(this.price);
      const down = target.lt(this.price);
      let next: SimOrder | null = null;
      for (const o of this.orders.values()) {
        if (o.status !== 'OPEN' || touched.has(o.clientOrderId)) continue;
        if (up && o.side === 'SELL' && o.price.gte(this.price) && o.price.lt(target) && (!next || o.price.lt(next.price))) next = o;
        if (down && o.side === 'BUY' && o.price.lte(this.price) && o.price.gt(target) && (!next || o.price.gt(next.price))) next = o;
      }
      if (!next) {
        this.price = target;
        this.outbox.push({ kind: 'book', book: this.currentBook() });
        await this.drain();
        return;
      }
      this.price = next.price;
      touched.add(next.clientOrderId);
      // The public book reflects the trade before our private fill arrives.
      this.outbox.push({ kind: 'book', book: this.currentBook() });
      this.fillOrder(next);
      this.outbox.push({ kind: 'book', book: this.currentBook() });
      await this.drain();
    }
    throw new Error('sim moveTo did not converge');
  }

  /** External withdrawal/deposit (drill: something moved funds the engine does not know about). */
  adjustBalances(base: Decimal, quote: Decimal) {
    this.base = this.base.plus(base);
    this.quote = this.quote.plus(quote);
  }
}
