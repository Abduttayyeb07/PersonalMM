import Decimal from 'decimal.js';
import { join } from 'path';
import * as protobuf from 'protobufjs';
import WebSocket from 'ws';
import { decodeMexcFrame } from '../../mexc/mexc-frame';
import { Clock, Logger, VenueSpecs } from '../types';
import { SimVenue } from './sim-venue';
import { PlaceRequest, VenueAdapter, VenueHandlers } from './venue';

let mexcWrapper: Promise<protobuf.Type> | null = null;
/** MEXC public streams are protobuf; the schema ships with the MEXC module (src/mexc/proto). */
function loadMexcWrapper() {
  mexcWrapper ??= protobuf.load(join(__dirname, '..', '..', 'mexc', 'proto', 'PushDataV3ApiWrapper.proto'))
    .then((root) => root.lookupType('PushDataV3ApiWrapper'));
  return mexcWrapper;
}

/**
 * Paper trading: live Bybit (or MEXC) public market data, simulated fills and balances. Orders never leave
 * this process, so no API key is needed. A resting order fills when a real trade prints strictly
 * through its price.
 */
export class PaperVenue implements VenueAdapter {
  readonly name = 'paper';
  private readonly sim: SimVenue;
  private ws: WebSocket | null = null;
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly o: {
    symbol: string; specs: VenueSpecs; clock: Clock; log: Logger; startBase: Decimal; startQuote: Decimal; startPrice: Decimal; idPrefix?: string;
    /** Which exchange's live trades drive the fills. Default Bybit. */
    feed?: 'BYBIT' | 'MEXC';
  }) {
    this.sim = new SimVenue({ specs: o.specs, clock: o.clock, startBase: o.startBase, startQuote: o.startQuote, startPrice: o.startPrice, idPrefix: o.idPrefix });
  }

  /** Every order, cancel and fill of this run, for the spec auditor. */
  get venueLog() { return this.sim.log; }

  getSpecs() { return this.sim.getSpecs(); }
  placeOrder(req: PlaceRequest) { return this.sim.placeOrder(req); }
  async cancelOrder(id: string) { await this.sim.cancelOrder(id); this.flush(); }
  async cancelAll() { await this.sim.cancelAll(); this.flush(); }
  getOpenOrders() { return this.sim.getOpenOrders(); }
  findOrder(id: string) { return this.sim.findOrder(id); }
  getFillsSince(ts: number) { return this.sim.getFillsSince(ts); }
  getBalances() { return this.sim.getBalances(); }
  getBook() { return this.sim.getBook(); }

  /** Market moves are applied one at a time, in arrival order. */
  private move(price: Decimal) {
    this.chain = this.chain.then(() => this.sim.moveTo(price)).catch((e) => this.o.log.error(`paper move: ${(e as Error).message}`));
  }

  private flush() {
    this.chain = this.chain.then(() => this.sim.drain());
  }

  async start(handlers: VenueHandlers) {
    await this.sim.start(handlers);
    this.stopped = false;
    this.connect(handlers, 0);
    return async () => {
      this.stopped = true;
      this.ws?.terminate();
    };
  }

  private connect(h: VenueHandlers, attempt: number) {
    if (this.stopped) return;
    if (this.o.feed === 'MEXC') {
      void this.connectMexc(h, attempt);
      return;
    }
    const ws = new WebSocket(`${process.env.BYBIT_WS_HOST || 'wss://stream.bybit.com'}/v5/public/spot`);
    this.ws = ws;
    let ping: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      attempt = 0;
      ws.send(JSON.stringify({ op: 'subscribe', args: [`orderbook.1.${this.o.symbol}`, `publicTrade.${this.o.symbol}`] }));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op: 'ping' })), 20_000);
      void h.onFeedStatus('market', true);
      void h.onFeedStatus('private', true); // simulated private feed is always "connected"
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.topic === `publicTrade.${this.o.symbol}`) {
          for (const t of m.data ?? []) this.move(new Decimal(t.p));
        } else if (m.topic === `orderbook.1.${this.o.symbol}` && m.data?.b?.[0]) {
          this.move(new Decimal(m.data.b[0][0]));
        }
      } catch { /* ignore malformed frames */ }
    });
    ws.on('close', () => {
      if (ping) clearInterval(ping);
      void h.onFeedStatus('market', false);
      if (!this.stopped) setTimeout(() => this.connect(h, attempt + 1), Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 1000);
    });
    ws.on('error', (e) => this.o.log.warn(`paper ws: ${e.message}`));
  }

  /** MEXC: protobuf aggregated deals and best bid/ask; JSON PING every 20 s (MEXC drops idle sockets). */
  private async connectMexc(h: VenueHandlers, attempt: number) {
    let wrapper: protobuf.Type;
    try {
      wrapper = await loadMexcWrapper();
    } catch (e) {
      this.o.log.error(`paper mexc: cannot load protobuf schema: ${(e as Error).message}`);
      return;
    }
    if (this.stopped) return;
    const sym = this.o.symbol;
    const ws = new WebSocket('wss://wbs-api.mexc.com/ws');
    this.ws = ws;
    let ping: NodeJS.Timeout | undefined;
    let maxAge: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      attempt = 0;
      ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: [`spot@public.aggre.deals.v3.api.pb@100ms@${sym}`, `spot@public.aggre.bookTicker.v3.api.pb@100ms@${sym}`],
      }));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ method: 'PING' })), 20_000);
      // MEXC closes a connection after 24 h: reconnect before that.
      maxAge = setTimeout(() => ws.terminate(), 23 * 3_600_000);
      void h.onFeedStatus('market', true);
      void h.onFeedStatus('private', true); // simulated private feed is always "connected"
    });
    ws.on('message', (raw: Buffer) => {
      try {
        const f = decodeMexcFrame(wrapper, raw);
        if (f.kind !== 'protobuf') return;
        const v = f.value as { publicAggreDeals?: { deals?: Array<{ price?: string }> }; publicAggreBookTicker?: { bidPrice?: string } };
        for (const d of v.publicAggreDeals?.deals ?? []) if (d.price) this.move(new Decimal(d.price));
        if (v.publicAggreBookTicker?.bidPrice) this.move(new Decimal(v.publicAggreBookTicker.bidPrice));
      } catch { /* ignore malformed frames */ }
    });
    ws.on('close', () => {
      if (ping) clearInterval(ping);
      if (maxAge) clearTimeout(maxAge);
      void h.onFeedStatus('market', false);
      if (!this.stopped) setTimeout(() => this.connect(h, attempt + 1), Math.min(1000 * 2 ** attempt, 30_000) + Math.random() * 1000);
    });
    ws.on('error', (e) => this.o.log.warn(`paper mexc ws: ${e.message}`));
  }
}
