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
import { Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import * as crypto from 'crypto';
import { CredentialLifecycleService } from '../credentials/credential-lifecycle.service';
import { normalizeOrderStatus } from '../exchange/order-state.util';

// Some networks block stream.bybit.com; set BYBIT_WS_HOST=wss://stream.bytick.com there.
const BYBIT_WS_URL = `${process.env.BYBIT_WS_HOST || 'wss://stream.bybit.com'}/v5/public/spot`;
const SYMBOL = 'ZIGUSDT';
const HEARTBEAT_INTERVAL = 20_000;
const PONG_TIMEOUT = 10_000;
const RECONNECT_DELAY = 3_000;
const MAX_RECONNECT_DELAY = 30_000;
const BYBIT_PRIVATE_URL = `${process.env.BYBIT_WS_HOST || 'wss://stream.bybit.com'}/v5/private`;

type PrivateState = { ws: WebSocket; ping: NodeJS.Timeout; intentional: boolean };

@WebSocketGateway({ cors: { origin: corsOrigin, credentials: true }, namespace: '/bybit' })
export class BybitGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(BybitGateway.name);

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private intentionalClose = false;
  private clientCount = 0;
  private readonly userClients = new Map<string, Set<Socket>>();
  private readonly privateStates = new Map<string, PrivateState>();

  constructor(private jwt: JwtService, private prisma: PrismaService, private credentials: CredentialsService, lifecycle: CredentialLifecycleService) {
    lifecycle.register('bybit', (userId) => this.disconnectUser(userId));
  }

  afterInit() {
    this.logger.log('Bybit WebSocket gateway initialized');
  }

  async handleConnection(client: Socket) {
    if (!(await this.authenticate(client))) return;
    client.data.authenticated = true;
    this.clientCount++;
    if (this.clientCount === 1) this.connectToBybit();
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
    if (this.clientCount === 0) this.disconnectFromBybit();
    const clients = this.userClients.get(client.data.userId);
    clients?.delete(client);
    if (clients?.size === 0) {
      this.userClients.delete(client.data.userId);
      this.disconnectPrivate(client.data.userId);
    }
  }

  private emitPrivate(userId: string, event: string, data: unknown) {
    for (const client of this.userClients.get(userId) ?? []) client.emit(event, data);
  }

  private async connectPrivate(userId: string, attempt = 0) {
    if (!this.userClients.has(userId) || this.privateStates.has(userId)) return;
    try {
      await this.credentials.withDecrypted(userId, 'bybit', async (creds) => {
        const ws = new WebSocket(BYBIT_PRIVATE_URL);
        const state: PrivateState = {
          ws,
          ping: setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' })); }, 20_000),
          intentional: false,
        };
        this.privateStates.set(userId, state);
        ws.once('open', () => {
          const expires = Date.now() + 10_000;
          const signature = crypto.createHmac('sha256', creds.apiSecret).update(`GET/realtime${expires}`).digest('hex');
          ws.send(JSON.stringify({ op: 'auth', args: [creds.apiKey, expires, signature] }));
        });
        ws.on('message', (raw: Buffer) => {
          try {
            const message = JSON.parse(raw.toString());
            if (message.op === 'auth' && message.success) ws.send(JSON.stringify({ op: 'subscribe', args: ['order', 'wallet'] }));
            if (message.topic === 'order') {
              this.emitPrivate(userId, 'order_update', message.data);
              for (const order of message.data ?? []) {
                void this.prisma.order.updateMany({
                  where: { userId, exchange: 'bybit', OR: [{ clientOrderId: order.orderLinkId }, { exchangeOrderId: order.orderId }] },
                  data: { status: normalizeOrderStatus('bybit', order.orderStatus), exchangeOrderId: order.orderId },
                });
              }
            }
            if (message.topic === 'wallet') this.emitPrivate(userId, 'balance_update', message.data);
          } catch { /* Ignore malformed upstream messages. */ }
        });
        ws.on('close', () => {
          if (this.privateStates.get(userId) !== state) return;
          clearInterval(state.ping);
          this.privateStates.delete(userId);
          if (!state.intentional && this.userClients.has(userId)) {
            const next = Math.min(attempt + 1, 6);
            setTimeout(() => void this.connectPrivate(userId, next), Math.min(1000 * 2 ** next, 30_000) + Math.floor(Math.random() * 500));
          }
        });
        ws.on('error', () => undefined);
      });
    } catch { /* Public data remains available when no private key exists. */ }
  }

  async disconnectUser(userId: string) {
    this.disconnectPrivate(userId);
  }

  private disconnectPrivate(userId: string) {
    const state = this.privateStates.get(userId);
    if (!state) return;
    state.intentional = true;
    clearInterval(state.ping);
    this.privateStates.delete(userId);
    state.ws.terminate();
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket) {
    client.emit('pong');
  }

  private connectToBybit() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.intentionalClose = false;
    this.logger.log('Connecting to Bybit WebSocket...');
    this.ws = new WebSocket(BYBIT_WS_URL);

    this.ws.on('open', () => {
      this.logger.log('Bybit WebSocket connected');
      this.reconnectDelay = RECONNECT_DELAY;
      this.subscribe();
      this.startHeartbeat();
      this.server.emit('ws_status', { connected: true });
    });

    this.ws.on('message', (raw: Buffer) => {
      this.clearPongTimer();
      try {
        const msg = JSON.parse(raw.toString());

        // Bybit pong / subscription ACK
        if (msg.op === 'pong' || msg.ret_msg === 'pong' || msg.op === 'subscribe') {
          return;
        }

        // Bybit sends server-initiated pings — respond
        if (msg.op === 'ping') {
          this.ws?.send(JSON.stringify({ op: 'pong' }));
          return;
        }

        if (msg.topic) this.handleBybitMessage(msg);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('close', (code) => {
      this.logger.warn(`Bybit WebSocket closed (code: ${code})`);
      this.stopHeartbeat();
      this.clearPongTimer();
      this.server.emit('ws_status', { connected: false });
      if (!this.intentionalClose && this.clientCount > 0) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`Bybit WebSocket error: ${err.message}`);
    });
  }

  private subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      op: 'subscribe',
      args: [
        `tickers.${SYMBOL}`,
        `orderbook.50.${SYMBOL}`,
        `publicTrade.${SYMBOL}`,
      ],
    }));
  }

  private handleBybitMessage(msg: any) {
    const topic: string = msg.topic ?? '';

    if (topic.startsWith('tickers.')) {
      const t = msg.data;
      if (!t) return;
      this.server.emit('ticker', {
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        change: parseFloat(t.price24hPcnt),   // decimal ratio, e.g. 0.0157
        high: parseFloat(t.highPrice24h),
        low: parseFloat(t.lowPrice24h),
        volume: parseFloat(t.volume24h),
      });
    } else if (topic.startsWith('orderbook.')) {
      const d = msg.data;
      if (!d) return;
      const bids = (d.b ?? []).map((b: string[]) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
      const asks = (d.a ?? []).map((a: string[]) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
      this.server.emit('orderbook', {
        bids,
        asks,
        full: msg.type === 'snapshot',
      });
    } else if (topic.startsWith('publicTrade.')) {
      const trades: any[] = msg.data ?? [];
      this.server.emit('trades', trades.map((t) => ({
        price: parseFloat(t.p),
        qty: parseFloat(t.v),
        time: t.T,
        side: t.S === 'Buy' ? 'BUY' : 'SELL',
      })));
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ op: 'ping' }));
      this.pongTimer = setTimeout(() => {
        this.logger.warn('No pong from Bybit — forcing reconnect');
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
    this.logger.log(`Reconnecting to Bybit in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToBybit();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, this.reconnectDelay);
  }

  private disconnectFromBybit() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.terminate();
    this.ws = null;
  }

  onModuleDestroy() {
    this.disconnectFromBybit();
    for (const userId of this.privateStates.keys()) this.disconnectPrivate(userId);
  }
}
