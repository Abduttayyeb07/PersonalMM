import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { corsOrigin } from '../config/origins';
import { Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import { join } from 'path';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { MexcService } from './mexc.service';
import { CredentialLifecycleService } from '../credentials/credential-lifecycle.service';
import { decodeMexcFrame } from './mexc-frame';

const MEXC_WS_URL = 'wss://wbs-api.mexc.com/ws';
const SYMBOL = 'ZIGUSDT';

// MEXC migrated public spot streams to protobuf-only `.pb` channels; the old
// JSON channels are deprecated and drop the connection. Frames on these are
// binary, wrapped in PushDataV3ApiWrapper. Control frames (sub ACK / PONG)
// are still JSON text.
const CH_DEPTH = `spot@public.limit.depth.v3.api.pb@${SYMBOL}@20`;
const CH_DEPTH_AGGRE = `spot@public.aggre.depth.v3.api.pb@100ms@${SYMBOL}`;
const CH_DEALS = `spot@public.aggre.deals.v3.api.pb@100ms@${SYMBOL}`;
const CH_BOOK = `spot@public.aggre.bookTicker.v3.api.pb@100ms@${SYMBOL}`;
const CH_TICKER = `spot@public.miniTicker.v3.api.pb@${SYMBOL}@UTC+8`;
const HEARTBEAT_INTERVAL = 20000;  // MEXC drops after ~60s no ping — send every 20s
const PONG_TIMEOUT = 10000;        // force reconnect if no pong within 10s
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_CONNECTION_AGE = 23 * 60 * 60 * 1000; // 23h — MEXC hard-closes at 24h
const PRIVATE_CHANNELS = ['spot@private.orders.v3.api.pb', 'spot@private.deals.v3.api.pb', 'spot@private.account.v3.api.pb'];

type PrivateState = {
  ws: WebSocket;
  listenKey: string;
  ping: NodeJS.Timeout;
  keepAlive: NodeJS.Timeout;
  intentional: boolean;
};

@WebSocketGateway({ cors: { origin: corsOrigin, credentials: true }, namespace: '/mexc' })
export class MexcGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(MexcGateway.name);

  private Wrapper!: protobuf.Type;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private maxAgeTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private intentionalClose = false;
  private clientCount = 0;
  private readonly userClients = new Map<string, Set<Socket>>();
  private readonly privateStates = new Map<string, PrivateState>();

  constructor(
    private jwt: JwtService,
    private prisma: PrismaService,
    private credentials: CredentialsService,
    private mexc: MexcService,
    lifecycle: CredentialLifecycleService,
  ) { lifecycle.register('mexc', (userId) => this.disconnectUser(userId)); }

  async onModuleInit() {
    // Load the protobuf schema once at startup. Imports resolve relative to
    // this file's dir (nest-cli copies src/mexc/proto/*.proto into dist).
    const root = await protobuf.load(
      join(__dirname, 'proto', 'PushDataV3ApiWrapper.proto'),
    );
    this.Wrapper = root.lookupType('PushDataV3ApiWrapper');
    this.logger.log('MEXC protobuf schema loaded');
  }

  afterInit() {
    this.logger.log('MEXC WebSocket gateway initialized');
  }

  async handleConnection(client: Socket) {
    if (!(await this.authenticate(client))) return;
    client.data.authenticated = true;
    this.clientCount++;
    if (this.clientCount === 1) this.connectToMexc();
    const clients = this.userClients.get(client.data.userId) ?? new Set<Socket>();
    clients.add(client);
    this.userClients.set(client.data.userId, clients);
    void this.connectPrivate(client.data.userId);
  }

  private async authenticate(client: Socket): Promise<boolean> {
    try {
      const cookie = client.handshake.headers.cookie ?? '';
      const token = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith('access_token='))?.slice('access_token='.length);
      if (!token) throw new Error('missing token');
      const payload = await this.jwt.verifyAsync<{ sub: string; jti?: string }>(decodeURIComponent(token));
      if (payload.jti && await this.prisma.revokedToken.findUnique({ where: { jti: payload.jti } })) throw new Error('revoked');
      client.data.userId = payload.sub;
      return true;
    } catch {
      client.disconnect(true);
      return false;
    }
  }

  handleDisconnect(client: Socket) {
    if (!client.data.authenticated) return;
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount === 0) this.disconnectFromMexc();
    const clients = this.userClients.get(client.data.userId);
    clients?.delete(client);
    if (clients?.size === 0) {
      this.userClients.delete(client.data.userId);
      void this.disconnectPrivate(client.data.userId);
    }
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket) {
    client.emit('pong');
  }

  private connectToMexc() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.intentionalClose = false;
    this.logger.log('Connecting to MEXC WebSocket...');
    this.ws = new WebSocket(MEXC_WS_URL);

    this.ws.on('open', () => {
      this.logger.log('MEXC WebSocket connected');
      this.reconnectDelay = RECONNECT_DELAY;
      this.subscribe();
      this.startHeartbeat();
      this.server.emit('ws_status', { connected: true });
      // MEXC hard-closes connections at 24h — proactively reconnect at 23h
      this.maxAgeTimer = setTimeout(() => {
        this.logger.log('23h connection age reached — cycling connection');
        this.intentionalClose = false; // allow reconnect after close
        this.ws?.terminate();
      }, MAX_CONNECTION_AGE);
    });

    this.ws.on('message', (raw: Buffer) => {
      // Any message from MEXC proves the connection is alive — clear dead timer
      this.clearPongTimer();

      // Control frames (sub ACK / PONG / errors) are JSON text and begin with
      // '{'. Market-data frames are binary protobuf (field 1 starts with 0x0a),
      // so they never start with '{'.
      if (raw.toString('utf8').trimStart().startsWith('{')) {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.id !== undefined || msg.code !== undefined || msg.msg || msg.method === 'PONG') {
            if (msg.code !== undefined && msg.code !== 0) {
              this.logger.warn(`MEXC: code=${msg.code} msg="${msg.msg}"`);
            }
            return;
          }
        } catch {
          // not a control frame — fall through
        }
        return;
      }

      // Binary protobuf market data
      try {
        const wrapper: any = this.Wrapper.decode(raw);
        this.handleMexcMessage(wrapper);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('close', (code) => {
      this.logger.warn(`MEXC WebSocket closed (code: ${code})`);
      this.stopHeartbeat();
      this.clearPongTimer();
      this.server.emit('ws_status', { connected: false });
      if (!this.intentionalClose && this.clientCount > 0) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`MEXC WebSocket error: ${err.message}`);
    });
  }

  private subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      method: 'SUBSCRIPTION',
      params: [CH_TICKER, CH_DEPTH, CH_DEPTH_AGGRE, CH_DEALS, CH_BOOK],
    }));
  }

  private handleMexcMessage(wrapper: any) {
    const channel: string = wrapper.channel ?? '';

    if (channel.includes('miniTicker')) {
      const t = wrapper.publicMiniTicker;
      if (t) {
        const price = parseFloat(t.price);
        const rate = parseFloat(t.rate);
        // miniTicker has no `open`; derive it from price and the rolling rate
        // so the emitted shape stays identical to the old JSON feed.
        const open = Number.isFinite(rate) && rate !== -1 ? price / (1 + rate) : price;
        this.server.emit('ticker', {
          symbol: wrapper.symbol ?? SYMBOL,
          price,
          open,
          high: parseFloat(t.high),
          low: parseFloat(t.low),
          volume: parseFloat(t.volume),
          change: rate,
        });
      }
    } else if (channel.includes('limit.depth')) {
      // Full snapshot — replace entire book
      const d = wrapper.publicLimitDepths;
      if (d) {
        this.server.emit('orderbook', {
          bids: (d.bids ?? []).map((b: any) => ({
            price: parseFloat(b.price),
            qty: parseFloat(b.quantity),
          })),
          asks: (d.asks ?? []).map((a: any) => ({
            price: parseFloat(a.price),
            qty: parseFloat(a.quantity),
          })),
          full: true,
        });
      }
    } else if (channel.includes('aggre.depth')) {
      const d = wrapper.publicAggreDepths;
      if (d) this.server.emit('orderbook', {
        bids: (d.bids ?? []).map((b: any) => ({ price: parseFloat(b.price), qty: parseFloat(b.quantity) })),
        asks: (d.asks ?? []).map((a: any) => ({ price: parseFloat(a.price), qty: parseFloat(a.quantity) })),
        full: false,
      });
    } else if (channel.includes('bookTicker')) {
      this.server.emit('best_bid_ask', wrapper.publicAggreBookTicker);
    } else if (channel.includes('deals')) {
      const deals: any[] = wrapper.publicAggreDeals?.deals ?? [];
      this.server.emit('trades', deals.map((d) => ({
        price: parseFloat(d.price),
        qty: parseFloat(d.quantity),
        time: typeof d.time?.toNumber === 'function' ? d.time.toNumber() : Number(d.time),
        side: d.tradeType === 1 ? 'BUY' : 'SELL',
      })));
    }
  }

  private emitPrivate(userId: string, event: string, data: unknown) {
    for (const client of this.userClients.get(userId) ?? []) client.emit(event, data);
  }

  private async connectPrivate(userId: string, attempt = 0) {
    if (!this.userClients.has(userId) || this.privateStates.has(userId)) return;
    try {
      const listenKey = await this.credentials.withDecrypted(userId, 'mexc', (creds) => this.mexc.createListenKey(creds));
      if (!this.userClients.has(userId)) return;
      const ws = new WebSocket(`${MEXC_WS_URL}?listenKey=${encodeURIComponent(listenKey)}`);
      const state: PrivateState = {
        ws, listenKey,
        ping: setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'PING' })); }, 30_000),
        keepAlive: setInterval(() => {
          void this.credentials.withDecrypted(userId, 'mexc', (creds) => this.mexc.keepAliveListenKey(creds, listenKey));
        }, 20 * 60_000),
        intentional: false,
      };
      this.privateStates.set(userId, state);
      ws.on('open', () => ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: PRIVATE_CHANNELS })));
      ws.on('message', (raw: Buffer) => this.handlePrivateFrame(userId, raw));
      ws.on('close', () => {
        if (this.privateStates.get(userId) !== state) return;
        clearInterval(state.ping); clearInterval(state.keepAlive);
        this.privateStates.delete(userId);
        if (!state.intentional && this.userClients.has(userId)) {
          const next = Math.min(attempt + 1, 6);
          const delay = Math.min(1000 * 2 ** next, 30_000) + Math.floor(Math.random() * 500);
          setTimeout(() => void this.connectPrivate(userId, next), delay);
        }
      });
      ws.on('error', () => undefined);
    } catch {
      // A user without valid MEXC credentials still receives the public stream.
    }
  }

  private handlePrivateFrame(userId: string, raw: Buffer) {
    if (!raw.length) return;
    try {
      const frame = decodeMexcFrame(this.Wrapper, raw);
      if (frame.kind === 'control') return;
      const wrapper: any = frame.value;
      const channel = String(wrapper.channel ?? '');
      if (channel.includes('private.orders')) {
        const order = wrapper.privateOrders;
        this.emitPrivate(userId, 'order_update', order);
        const states: Record<string, string> = { '1': 'NEW', '2': 'FILLED', '3': 'PARTIALLY_FILLED', '4': 'CANCELED' };
        void this.prisma.order.updateMany({
          where: { userId, exchange: 'mexc', OR: [{ clientOrderId: order?.clientId }, { exchangeOrderId: order?.id }] },
          data: { status: states[String(order?.status)] ?? String(order?.status ?? 'NEW'), exchangeOrderId: order?.id ? String(order.id) : undefined },
        });
      } else if (channel.includes('private.deals')) {
        this.emitPrivate(userId, 'fill_update', wrapper.privateDeals);
      } else if (channel.includes('private.account')) {
        this.emitPrivate(userId, 'balance_update', wrapper.privateAccount);
      }
    } catch { /* JSON control and malformed frames never reach the protobuf consumer. */ }
  }

  async disconnectUser(userId: string) {
    await this.disconnectPrivate(userId);
  }

  private async disconnectPrivate(userId: string) {
    const state = this.privateStates.get(userId);
    if (!state) return;
    state.intentional = true;
    clearInterval(state.ping); clearInterval(state.keepAlive);
    this.privateStates.delete(userId);
    state.ws.terminate();
    try {
      await this.credentials.withDecrypted(userId, 'mexc', (creds) => this.mexc.deleteListenKey(creds, state.listenKey));
    } catch { /* It may already be expired or the credential may have been removed. */ }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;

      this.ws.send(JSON.stringify({ method: 'PING' }));

      // If MEXC doesn't respond (no message at all) within PONG_TIMEOUT, connection is dead
      this.pongTimer = setTimeout(() => {
        this.logger.warn('No response from MEXC — forcing reconnect');
        this.ws?.terminate();
      }, PONG_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.logger.log(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToMexc();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, this.reconnectDelay);
  }

  private disconnectFromMexc() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.maxAgeTimer) {
      clearTimeout(this.maxAgeTimer);
      this.maxAgeTimer = null;
    }
    this.ws?.terminate();
    this.ws = null;
  }

  onModuleDestroy() {
    this.disconnectFromMexc();
    for (const userId of this.privateStates.keys()) void this.disconnectPrivate(userId);
  }
}
