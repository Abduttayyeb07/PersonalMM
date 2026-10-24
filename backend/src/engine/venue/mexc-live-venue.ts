import axios, { AxiosInstance, isAxiosError } from 'axios';
import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import { Balances, Book, Clock, Fill, Logger, OpenOrder, PlaceResult, VenueSpecs } from '../types';
import { PlaceRequest, VenueAdapter, VenueHandlers } from './venue';

const ZERO = new Decimal(0);
const BASE_URL = 'https://api.mexc.com';

export interface MexcLiveOptions {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  specs: VenueSpecs;
  apiKey: string;
  apiSecret: string;
  clock: Clock;
  log: Logger;
  /** True for client order IDs this simulation issued. Every other order on the account is left alone. */
  owns: (clientOrderId: string) => boolean;
  /**
   * The simulation's slice of the account when it starts (or, on a resume, what its records say it
   * holds). Reported balances are this plus the effect of this simulation's own fills, so other
   * coins and manual trades on the same account never confuse the engine.
   */
  wallet: { base: Decimal; quote: Decimal };
  /** Fill IDs already booked (on a resume), so they are not counted twice. */
  knownFillIds?: Iterable<string>;
  /** Look back this far for fills on the first poll (resume: since the last booked fill). */
  fillsFrom?: number;
  pollMs?: number;
  bookMs?: number;
  /** Tests inject a fake HTTP client. */
  http?: AxiosInstance;
}

interface Tracked {
  orderId: string;
  side: 'BUY' | 'SELL';
  price: Decimal;
  qty: Decimal;
  placedAt: number;
}

/**
 * Real MEXC spot trading for one simulation. Orders are LIMIT_MAKER (post-only: MEXC rejects any
 * that would take), so we are always maker. Fills and order states come from REST polling every
 * couple of seconds; the engine cross-checks them on its own schedule too. Only orders this
 * simulation placed are ever read, cancelled or counted.
 */
export class MexcLiveVenue implements VenueAdapter {
  readonly name = 'mexc-live';
  private readonly http: AxiosInstance;
  private readonly tracked = new Map<string, Tracked>();
  private readonly cancelledByUs = new Set<string>();
  private readonly seenFills = new Set<string>();
  /** The wallet slice: starting amounts plus every own fill counted so far. */
  private base: Decimal;
  private quote: Decimal;
  private timers: NodeJS.Timeout[] = [];
  private lastTradeTs: number;
  private lastBook: Book | null = null;
  private stopped = false;

  constructor(private readonly o: MexcLiveOptions) {
    this.http = o.http ?? axios.create({ baseURL: BASE_URL, timeout: 10_000, headers: { 'X-MEXC-APIKEY': o.apiKey } });
    this.base = o.wallet.base;
    this.quote = o.wallet.quote;
    for (const id of o.knownFillIds ?? []) this.seenFills.add(id);
    this.lastTradeTs = o.fillsFrom ?? o.clock.now();
  }

  // ── Signed REST ──────────────────────────────────────────────────────────────────────────────

  private signed(params: Record<string, string | number>) {
    const qs = new URLSearchParams(
      Object.entries({ ...params, timestamp: Date.now(), recvWindow: 10_000 }).map(([k, v]) => [k, String(v)]),
    ).toString();
    const signature = crypto.createHmac('sha256', this.o.apiSecret).update(qs).digest('hex');
    return `${qs}&signature=${signature}`;
  }

  private async get(path: string, params: Record<string, string | number> = {}) {
    return (await this.http.get(`${path}?${this.signed(params)}`)).data;
  }

  private static errorText(e: unknown): { status?: number; code?: number; msg: string } {
    if (isAxiosError(e)) {
      const d = e.response?.data as { code?: number; msg?: string } | undefined;
      return { status: e.response?.status, code: d?.code, msg: d?.msg ?? e.message };
    }
    return { msg: (e as Error).message };
  }

  // ── VenueAdapter ─────────────────────────────────────────────────────────────────────────────

  async getSpecs() { return this.o.specs; }

  async placeOrder(req: PlaceRequest): Promise<PlaceResult> {
    if (!this.o.owns(req.clientOrderId)) return { ok: false, reason: 'INVALID', message: `refusing to place foreign id ${req.clientOrderId}` };
    try {
      const data = (await this.http.post(`/api/v3/order?${this.signed({
        symbol: this.o.symbol, side: req.side, type: 'LIMIT_MAKER',
        quantity: req.qty.toFixed(), price: req.price.toFixed(), newClientOrderId: req.clientOrderId,
      })}`)).data;
      const orderId = String(data?.orderId ?? '');
      if (!orderId) throw new Error(`MEXC returned no order id: ${JSON.stringify(data)}`);
      this.tracked.set(req.clientOrderId, { orderId, side: req.side, price: req.price, qty: req.qty, placedAt: this.o.clock.now() });
      return { ok: true, orderId };
    } catch (e) {
      const err = MexcLiveVenue.errorText(e);
      // No answer from MEXC: the order may or may not exist. The engine looks it up by client ID.
      if (err.status === undefined) throw e;
      const msg = `${err.code ?? err.status}: ${err.msg}`;
      if (err.status === 429 || /too many|frequent|rate/i.test(err.msg)) return { ok: false, reason: 'RATE_LIMIT', message: msg };
      if (/insufficient|balance|oversold/i.test(err.msg)) return { ok: false, reason: 'INSUFFICIENT_BALANCE', message: msg };
      if (/maker|immediately|post.?only|would (match|trade)/i.test(err.msg)) return { ok: false, reason: 'WOULD_CROSS', message: msg };
      if (/price.*(limit|range|exceed|higher|lower)/i.test(err.msg)) return { ok: false, reason: 'PRICE_LIMIT', message: msg };
      if (err.status >= 500) return { ok: false, reason: 'UNAVAILABLE', message: msg };
      return { ok: false, reason: 'INVALID', message: msg };
    }
  }

  async cancelOrder(clientOrderId: string) {
    if (!this.o.owns(clientOrderId)) return;
    this.cancelledByUs.add(clientOrderId);
    try {
      await this.http.delete(`/api/v3/order?${this.signed({ symbol: this.o.symbol, origClientOrderId: clientOrderId })}`);
    } catch (e) {
      const err = MexcLiveVenue.errorText(e);
      // Already gone (filled or cancelled): that is the outcome we wanted.
      if (err.status !== undefined && /not exist|unknown order|-2011|order.*(filled|cancel)/i.test(`${err.code} ${err.msg}`)) return;
      throw e;
    } finally {
      this.tracked.delete(clientOrderId);
    }
  }

  /** Cancels this simulation's open orders only, one by one, never the whole symbol. */
  async cancelAll() {
    for (const o of await this.getOpenOrders()) await this.cancelOrder(o.clientOrderId);
    for (const id of [...this.tracked.keys()]) await this.cancelOrder(id).catch(() => undefined);
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    const rows: any[] = await this.get('/api/v3/openOrders', { symbol: this.o.symbol });
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => this.o.owns(String(r.clientOrderId ?? '')))
      .map((r) => ({
        clientOrderId: String(r.clientOrderId), orderId: String(r.orderId), side: r.side === 'SELL' ? 'SELL' : 'BUY',
        price: new Decimal(r.price), qty: new Decimal(r.origQty), filledQty: new Decimal(r.executedQty ?? 0),
      }));
  }

  async findOrder(clientOrderId: string) {
    try {
      const r = await this.get('/api/v3/order', { symbol: this.o.symbol, origClientOrderId: clientOrderId });
      const status = String(r?.status ?? '');
      const filledQty = new Decimal(r?.executedQty ?? 0);
      const open = status === 'NEW' || status === 'PARTIALLY_FILLED';
      return {
        found: true,
        open: open ? {
          clientOrderId, orderId: String(r.orderId), side: (r.side === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          price: new Decimal(r.price), qty: new Decimal(r.origQty), filledQty,
        } : undefined,
        cancelled: status === 'CANCELED' || status === 'PARTIALLY_CANCELED',
        filledQty,
      };
    } catch (e) {
      const err = MexcLiveVenue.errorText(e);
      if (err.status !== undefined && /not exist|unknown order|-2013/i.test(`${err.code} ${err.msg}`)) return { found: false };
      throw e;
    }
  }

  /** Fills of this simulation since `ts`, also counted into the wallet slice (each one once). */
  async getFillsSince(ts: number): Promise<Fill[]> {
    const fills = await this.fetchFills(ts);
    for (const f of fills) this.count(f);
    return fills;
  }

  private async fetchFills(ts: number): Promise<Fill[]> {
    const rows: any[] = await this.get('/api/v3/myTrades', { symbol: this.o.symbol, startTime: Math.max(0, ts), limit: 1000 });
    const byOrderId = new Map([...this.tracked.entries()].map(([cid, t]) => [t.orderId, cid]));
    const out: Fill[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const clientOrderId = String(r.clientOrderId || byOrderId.get(String(r.orderId)) || '');
      if (!this.o.owns(clientOrderId)) continue;
      const asset = String(r.commissionAsset ?? '');
      let feeAsset: 'base' | 'quote' = asset === this.o.baseAsset ? 'base' : 'quote';
      let feeAmount = new Decimal(r.commission ?? 0);
      if (asset && asset !== this.o.baseAsset && asset !== this.o.quoteAsset) {
        // Paid in another coin (MX deduction): it does not change this pair's balances.
        this.o.log.warn(`mexc fill ${r.id}: fee ${r.commission} ${asset} paid outside ${this.o.symbol}; counted as 0`);
        feeAsset = 'quote';
        feeAmount = ZERO;
      }
      out.push({
        fillId: `mexc-${r.id}`, clientOrderId, orderId: String(r.orderId), side: r.isBuyer ? 'BUY' : 'SELL',
        price: new Decimal(r.price), qty: new Decimal(r.qty), feeAmount, feeAsset, ts: Number(r.time),
      });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** The simulation's wallet slice (see MexcLiveOptions.wallet). */
  async getBalances(): Promise<Balances> {
    return { base: this.base, quote: this.quote };
  }

  /** What the real account holds in this pair's two assets (free + locked). */
  async getAccountBalances(): Promise<{ base: Decimal; quote: Decimal; baseFree: Decimal; quoteFree: Decimal }> {
    const data = await this.get('/api/v3/account');
    const find = (a: string) => (data?.balances ?? []).find((b: any) => b.asset === a) ?? { free: '0', locked: '0' };
    const b = find(this.o.baseAsset);
    const q = find(this.o.quoteAsset);
    return {
      base: new Decimal(b.free).plus(b.locked), quote: new Decimal(q.free).plus(q.locked),
      baseFree: new Decimal(b.free), quoteFree: new Decimal(q.free),
    };
  }

  async getBook(): Promise<Book> {
    const { data } = await this.http.get('/api/v3/ticker/bookTicker', { params: { symbol: this.o.symbol } });
    return { bestBid: new Decimal(data.bidPrice), bestAsk: new Decimal(data.askPrice), ts: this.o.clock.now() };
  }

  /** Counts a fill into the wallet slice once. Returns false if it was already counted. */
  private count(f: Fill): boolean {
    if (this.seenFills.has(f.fillId)) return false;
    this.seenFills.add(f.fillId);
    const value = f.price.mul(f.qty);
    if (f.side === 'BUY') {
      this.base = this.base.plus(f.qty).minus(f.feeAsset === 'base' ? f.feeAmount : ZERO);
      this.quote = this.quote.minus(value).minus(f.feeAsset === 'quote' ? f.feeAmount : ZERO);
    } else {
      this.base = this.base.minus(f.qty).minus(f.feeAsset === 'base' ? f.feeAmount : ZERO);
      this.quote = this.quote.plus(value).minus(f.feeAsset === 'quote' ? f.feeAmount : ZERO);
    }
    return true;
  }

  private handlers: VenueHandlers | null = null;
  private bookBusy = false;
  private bookFails = 0;
  private privBusy = false;
  private privFails = 0;

  /** One market-data poll (the timer calls it every second; tests call it directly). */
  async pollBook() {
    const h = this.handlers;
    if (!h || this.bookBusy || this.stopped) return;
    this.bookBusy = true;
    try {
      const book = await this.getBook();
      if (this.bookFails > 0 || !this.lastBook) await h.onFeedStatus('market', true);
      this.bookFails = 0;
      this.lastBook = book;
      // Sent every time, unchanged or not: it also proves the feed is alive.
      await h.onBook(book);
    } catch (e) {
      this.bookFails += 1;
      if (this.bookFails === 5) {
        this.o.log.warn(`mexc book: ${(e as Error).message}`);
        await h.onFeedStatus('market', false);
      }
    } finally {
      this.bookBusy = false;
    }
  }

  /** One account poll: new fills, and orders that left the book without us cancelling them. */
  async pollPrivate() {
    const h = this.handlers;
    if (!h || this.privBusy || this.stopped) return;
    this.privBusy = true;
    try {
      // Fills: everything since a minute before the newest one we have seen.
      const fills = await this.fetchFills(this.lastTradeTs - 60_000);
      for (const f of fills) {
        if (f.ts > this.lastTradeTs) this.lastTradeTs = f.ts;
        if (this.count(f)) await h.onFill(f);
      }
      // Filled orders are explained by the fills above. Anything cancelled that we did not cancel is
      // either MEXC refusing a post-only order right after placing, or someone else (the engine halts).
      const open = new Set((await this.getOpenOrders()).map((o) => o.clientOrderId));
      for (const [cid, t] of [...this.tracked.entries()]) {
        if (open.has(cid)) continue;
        const found = await this.findOrder(cid);
        if (!found.found || found.open) continue;
        this.tracked.delete(cid);
        if (!found.cancelled || this.cancelledByUs.has(cid)) continue;
        const filled = found.filledQty ?? ZERO;
        const young = this.o.clock.now() - t.placedAt < 30_000;
        await h.onOrderUpdate({
          clientOrderId: cid, orderId: t.orderId, filledQty: filled, ts: this.o.clock.now(),
          status: young && filled.isZero() ? 'REJECTED' : 'CANCELLED',
        });
      }
      if (this.privFails > 0) await h.onFeedStatus('private', true);
      this.privFails = 0;
    } catch (e) {
      this.privFails += 1;
      if (this.privFails === 5) {
        this.o.log.warn(`mexc private: ${(e as Error).message}`);
        await h.onFeedStatus('private', false);
      }
    } finally {
      this.privBusy = false;
    }
  }

  async start(h: VenueHandlers, opts: { timers?: boolean } = {}) {
    this.stopped = false;
    this.handlers = h;
    // Pick up what is already open for this simulation (a resume), so it is watched like the rest.
    for (const o of await this.getOpenOrders().catch(() => [] as OpenOrder[])) {
      this.tracked.set(o.clientOrderId, { orderId: o.orderId, side: o.side, price: o.price, qty: o.qty, placedAt: 0 });
    }
    await h.onFeedStatus('private', true);
    await this.pollBook();
    if (opts.timers !== false) {
      this.timers.push(setInterval(() => void this.pollBook(), this.o.bookMs ?? 1000));
      this.timers.push(setInterval(() => void this.pollPrivate(), this.o.pollMs ?? 2000));
    }
    return async () => {
      this.stopped = true;
      for (const t of this.timers) clearInterval(t);
      this.timers = [];
    };
  }
}
