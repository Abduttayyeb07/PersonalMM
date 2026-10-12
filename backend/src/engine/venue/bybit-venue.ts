import axios, { AxiosInstance, isAxiosError } from 'axios';
import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import WebSocket from 'ws';
import { buildOrderId } from '../order-id';
import { Balances, Book, Clock, Fill, Logger, OpenOrder, OrderUpdate, PlaceResult, Side, VenueSpecs, systemClock } from '../types';
import { PlaceRequest, VenueAdapter, VenueHandlers } from './venue';

const REST = 'https://api.bybit.com';
// Some networks block stream.bybit.com; Bybit's alternate domain is stream.bytick.com.
const wsHost = () => process.env.BYBIT_WS_HOST || 'wss://stream.bybit.com';
const WS_PUBLIC = () => `${wsHost()}/v5/public/spot`;
const WS_PRIVATE = () => `${wsHost()}/v5/private`;
const RECV_WINDOW = '5000';
const MAX_LINK_ID = 36;

export interface BybitVenueOptions {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  apiKey: string;
  apiSecret: string;
  log: Logger;
  clock?: Clock;
  accountType?: 'UNIFIED' | 'SPOT';
  /** Venue self-match prevention as a backstop to our own guards. Verify on day 1 with a tiny order. */
  smpType?: 'CancelTaker' | 'CancelMaker' | 'CancelBoth' | null;
  /** Requests per second ceiling (Bybit allows more; we stay well under). */
  maxRequestsPerSecond?: number;
}

/** Bybit errors that mean "this order definitively did not happen" and why. */
function classify(retCode: number, retMsg: string): PlaceResult & { ok: false } {
  const msg = `${retCode} ${retMsg}`;
  const lower = retMsg.toLowerCase();
  if (retCode === 10006 || retCode === 10018 || lower.includes('too many')) return { ok: false, reason: 'RATE_LIMIT', message: msg };
  if (retCode === 170131 || lower.includes('insufficient')) return { ok: false, reason: 'INSUFFICIENT_BALANCE', message: msg };
  if (lower.includes('postonly') || lower.includes('post only') || lower.includes('take liquidity')) return { ok: false, reason: 'WOULD_CROSS', message: msg };
  if ([170193, 170194, 170195, 170196].includes(retCode) || (lower.includes('price') && (lower.includes('higher than') || lower.includes('lower than')))) {
    return { ok: false, reason: 'PRICE_LIMIT', message: msg };
  }
  if (retCode === 10016 || retCode === 10019 || lower.includes('maintenance') || lower.includes('service unavailable')) {
    return { ok: false, reason: 'UNAVAILABLE', message: msg };
  }
  return { ok: false, reason: 'INVALID', message: msg };
}

/**
 * Bybit V5 spot adapter. REST for orders and reconciliation, the public WebSocket (level-1 book) and
 * the private WebSocket (execution + order topics) for events. Every order is post-only.
 * Network errors and timeouts are THROWN (ambiguous: the engine looks the order up by client ID);
 * definitive rejections are returned.
 */
export class BybitVenue implements VenueAdapter {
  readonly name = 'bybit';
  private readonly http: AxiosInstance;
  private readonly clock: Clock;
  private lastRequests: number[] = [];
  private sockets: WebSocket[] = [];
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private readonly o: BybitVenueOptions) {
    this.http = axios.create({ baseURL: REST, timeout: 10_000 });
    this.clock = o.clock ?? systemClock;
    const longest = buildOrderId(o.symbol, 'XXXX-99', 9999, 'BUY', 99);
    if (longest.length > MAX_LINK_ID) throw new Error(`client order ids for ${o.symbol} exceed Bybit's ${MAX_LINK_ID} characters`);
  }

  // ── signing and pacing ──────────────────────────────────────────────────────────────────────

  private async pace() {
    const limit = this.o.maxRequestsPerSecond ?? 8;
    for (;;) {
      const now = Date.now();
      this.lastRequests = this.lastRequests.filter((t) => now - t < 1000);
      if (this.lastRequests.length < limit) { this.lastRequests.push(now); return; }
      await new Promise((r) => setTimeout(r, 1000 - (now - this.lastRequests[0])));
    }
  }

  private headers(payload: string) {
    const ts = Date.now().toString();
    const sign = crypto.createHmac('sha256', this.o.apiSecret).update(`${ts}${this.o.apiKey}${RECV_WINDOW}${payload}`).digest('hex');
    return { 'X-BAPI-API-KEY': this.o.apiKey, 'X-BAPI-SIGN': sign, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': RECV_WINDOW };
  }

  private async get(path: string, params: Record<string, string | number | undefined>, signed = true) {
    await this.pace();
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    const { data } = await this.http.get(`${path}?${qs}`, signed ? { headers: this.headers(qs) } : undefined);
    return data;
  }

  private async post(path: string, body: Record<string, unknown>) {
    await this.pace();
    const json = JSON.stringify(body);
    const { data } = await this.http.post(path, json, { headers: { ...this.headers(json), 'Content-Type': 'application/json' } });
    return data;
  }

  private ok(data: any, what: string) {
    if (data?.retCode !== 0) throw new Error(`Bybit ${what} failed: ${data?.retCode} ${data?.retMsg}`);
    return data.result;
  }

  // ── VenueAdapter ────────────────────────────────────────────────────────────────────────────

  async getSpecs(): Promise<VenueSpecs> {
    const info = this.ok(await this.get('/v5/market/instruments-info', { category: 'spot', symbol: this.o.symbol }, false), 'instruments-info').list?.[0];
    if (!info) throw new Error(`${this.o.symbol} is not listed on Bybit spot`);
    if (info.status !== 'Trading') throw new Error(`${this.o.symbol} status is ${info.status}`);
    const fee = this.ok(await this.get('/v5/account/fee-rate', { category: 'spot', symbol: this.o.symbol }), 'fee-rate').list?.[0];
    if (!fee) throw new Error('fee rate unavailable for this key');
    return {
      tick: new Decimal(info.priceFilter.tickSize),
      lot: new Decimal(info.lotSizeFilter.basePrecision),
      minOrderValue: new Decimal(info.lotSizeFilter.minOrderAmt),
      makerFee: new Decimal(fee.makerFeeRate),
      // Bybit spot charges a buy's fee in the asset received (base). Every fill reports feeCurrency
      // and the engine books it per fill; a wrong assumption here trips invariant I1 within one cycle.
      buyFeeAsset: 'base',
      maxOpenOrders: 500,
    };
  }

  async placeOrder(req: PlaceRequest): Promise<PlaceResult> {
    const body: Record<string, unknown> = {
      category: 'spot', symbol: this.o.symbol, side: req.side === 'BUY' ? 'Buy' : 'Sell', orderType: 'Limit',
      qty: req.qty.toFixed(), price: req.price.toFixed(), timeInForce: 'PostOnly', orderLinkId: req.clientOrderId,
    };
    if (this.o.smpType) body.smpType = this.o.smpType;
    let data;
    try {
      data = await this.post('/v5/order/create', body);
    } catch (e) {
      if (isAxiosError(e) && e.response && e.response.status >= 500) return { ok: false, reason: 'UNAVAILABLE', message: `HTTP ${e.response.status}` };
      throw e; // timeout / network: ambiguous, the engine resolves it by client ID
    }
    if (data?.retCode === 0) return { ok: true, orderId: String(data.result?.orderId ?? '') };
    return classify(Number(data?.retCode), String(data?.retMsg ?? ''));
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const data = await this.post('/v5/order/cancel', { category: 'spot', symbol: this.o.symbol, orderLinkId: clientOrderId });
    // 170213 / 110001: order does not exist (already filled or cancelled) - not an error.
    if (data?.retCode !== 0 && ![170213, 110001].includes(Number(data?.retCode))) {
      throw new Error(`Bybit cancel failed: ${data?.retCode} ${data?.retMsg}`);
    }
  }

  async cancelAll(): Promise<void> {
    this.ok(await this.post('/v5/order/cancel-all', { category: 'spot', symbol: this.o.symbol }), 'cancel-all');
  }

  private toOpen(o: any): OpenOrder {
    return {
      clientOrderId: o.orderLinkId, orderId: o.orderId, side: o.side === 'Buy' ? 'BUY' : 'SELL',
      price: new Decimal(o.price), qty: new Decimal(o.qty), filledQty: new Decimal(o.cumExecQty ?? 0),
    };
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    const out: OpenOrder[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = this.ok(await this.get('/v5/order/realtime', { category: 'spot', symbol: this.o.symbol, openOnly: 0, limit: 50, cursor }), 'open orders');
      for (const o of r.list ?? []) if (['New', 'PartiallyFilled', 'Untriggered'].includes(o.orderStatus)) out.push(this.toOpen(o));
      cursor = r.nextPageCursor;
      if (!cursor) break;
    }
    return out;
  }

  async findOrder(clientOrderId: string) {
    for (const path of ['/v5/order/realtime', '/v5/order/history']) {
      const r = this.ok(await this.get(path, { category: 'spot', symbol: this.o.symbol, orderLinkId: clientOrderId }), 'find order');
      const o = r.list?.[0];
      if (!o) continue;
      const open = ['New', 'PartiallyFilled'].includes(o.orderStatus);
      return {
        found: true,
        cancelled: ['Cancelled', 'PartiallyFilledCanceled', 'Rejected', 'Deactivated'].includes(o.orderStatus),
        filledQty: new Decimal(o.cumExecQty ?? 0),
        open: open ? this.toOpen(o) : undefined,
      };
    }
    return { found: false };
  }

  private toFill(e: any): Fill {
    return {
      fillId: `bybit:${e.execId}`,
      clientOrderId: e.orderLinkId,
      orderId: e.orderId,
      side: (e.side === 'Buy' ? 'BUY' : 'SELL') as Side,
      price: new Decimal(e.execPrice),
      qty: new Decimal(e.execQty),
      feeAmount: new Decimal(e.execFee || 0),
      feeAsset: e.feeCurrency === this.o.baseAsset ? 'base' : 'quote',
      ts: Number(e.execTime),
    };
  }

  async getFillsSince(ts: number): Promise<Fill[]> {
    const out: Fill[] = [];
    // Bybit limits a query window to 7 days.
    const start = Math.max(ts, this.clock.now() - 7 * 24 * 3600 * 1000 + 60_000);
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = this.ok(await this.get('/v5/execution/list', { category: 'spot', symbol: this.o.symbol, startTime: start, limit: 100, cursor }), 'executions');
      for (const e of r.list ?? []) out.push(this.toFill(e));
      cursor = r.nextPageCursor;
      if (!cursor) break;
    }
    return out;
  }

  async getBalances(): Promise<Balances> {
    const accountType = this.o.accountType ?? 'UNIFIED';
    const r = this.ok(await this.get('/v5/account/wallet-balance', { accountType, coin: `${this.o.baseAsset},${this.o.quoteAsset}` }), 'wallet-balance');
    const coins: any[] = r.list?.[0]?.coin ?? [];
    const total = (c: string) => new Decimal(coins.find((x) => x.coin === c)?.walletBalance || 0);
    return { base: total(this.o.baseAsset), quote: total(this.o.quoteAsset) };
  }

  async getBook(): Promise<Book> {
    const r = this.ok(await this.get('/v5/market/orderbook', { category: 'spot', symbol: this.o.symbol, limit: 1 }, false), 'orderbook');
    return { bestBid: new Decimal(r.b[0][0]), bestAsk: new Decimal(r.a[0][0]), ts: Number(r.ts) };
  }

  // ── WebSockets ─────────────────────────────────────────────────────────────────────────────

  async start(handlers: VenueHandlers) {
    this.stopped = false;
    this.connectPublic(handlers, 0);
    this.connectPrivate(handlers, 0);
    return async () => {
      this.stopped = true;
      for (const t of this.timers) clearInterval(t);
      for (const s of this.sockets) s.terminate();
      this.sockets = [];
    };
  }

  private backoff(attempt: number) {
    return Math.min(1000 * 2 ** attempt, 30_000) + Math.floor(Math.random() * 1000);
  }

  private connectPublic(h: VenueHandlers, attempt: number) {
    if (this.stopped) return;
    const ws = new WebSocket(WS_PUBLIC());
    this.sockets.push(ws);
    let ping: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      attempt = 0;
      ws.send(JSON.stringify({ op: 'subscribe', args: [`orderbook.1.${this.o.symbol}`] }));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op: 'ping' })), 20_000);
      this.timers.push(ping);
      void h.onFeedStatus('market', true);
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.topic !== `orderbook.1.${this.o.symbol}` || !m.data) return;
        const bid = m.data.b?.[0]?.[0];
        const ask = m.data.a?.[0]?.[0];
        if (bid && ask) void h.onBook({ bestBid: new Decimal(bid), bestAsk: new Decimal(ask), ts: Number(m.ts) });
      } catch { /* ignore malformed frames */ }
    });
    ws.on('close', () => {
      if (ping) clearInterval(ping);
      void h.onFeedStatus('market', false);
      if (!this.stopped) setTimeout(() => this.connectPublic(h, attempt + 1), this.backoff(attempt));
    });
    ws.on('error', (e) => this.o.log.warn(`bybit public ws: ${e.message}`));
  }

  private connectPrivate(h: VenueHandlers, attempt: number) {
    if (this.stopped) return;
    const ws = new WebSocket(WS_PRIVATE());
    this.sockets.push(ws);
    let ping: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      const expires = Date.now() + 10_000;
      const signature = crypto.createHmac('sha256', this.o.apiSecret).update(`GET/realtime${expires}`).digest('hex');
      ws.send(JSON.stringify({ op: 'auth', args: [this.o.apiKey, expires, signature] }));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op: 'ping' })), 20_000);
      this.timers.push(ping);
    });
    ws.on('message', (raw: Buffer) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.op === 'auth') {
        if (m.success) {
          attempt = 0;
          ws.send(JSON.stringify({ op: 'subscribe', args: ['execution.spot', 'order.spot'] }));
          void h.onFeedStatus('private', true);
        } else {
          this.o.log.error('bybit private ws auth failed');
          ws.terminate();
        }
        return;
      }
      if (m.topic === 'execution.spot' || m.topic === 'execution') {
        for (const e of m.data ?? []) if (e.symbol === this.o.symbol && e.orderLinkId) void h.onFill(this.toFill(e));
      }
      if (m.topic === 'order.spot' || m.topic === 'order') {
        for (const o of m.data ?? []) {
          if (o.symbol !== this.o.symbol || !o.orderLinkId) continue;
          const update = this.toUpdate(o);
          if (update) void h.onOrderUpdate(update);
        }
      }
    });
    ws.on('close', () => {
      if (ping) clearInterval(ping);
      void h.onFeedStatus('private', false);
      if (!this.stopped) setTimeout(() => this.connectPrivate(h, attempt + 1), this.backoff(attempt));
    });
    ws.on('error', (e) => this.o.log.warn(`bybit private ws: ${e.message}`));
  }

  private toUpdate(o: any): OrderUpdate | null {
    const filledQty = new Decimal(o.cumExecQty ?? 0);
    const base = { clientOrderId: o.orderLinkId, orderId: o.orderId, filledQty, ts: Number(o.updatedTime ?? Date.now()) };
    // A post-only order that would have crossed is cancelled by Bybit with this reject reason.
    if (o.rejectReason === 'EC_PostOnlyWillTakeLiquidity' || o.orderStatus === 'Rejected') return { ...base, status: 'REJECTED' };
    if (o.orderStatus === 'Cancelled' || o.orderStatus === 'PartiallyFilledCanceled' || o.orderStatus === 'Deactivated') {
      return { ...base, status: 'CANCELLED' };
    }
    return null;
  }
}
