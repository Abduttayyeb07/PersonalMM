import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';

const GATEIO_WS_URL = 'wss://api.gateio.ws/ws/v4/';
const SYMBOL = 'ZIG_USDT';
const PING_INTERVAL = 25_000; // Gate.io expects a ping every 30s; send at 25s
const RECONNECT_DELAY = 3_000;
const MAX_RECONNECT_DELAY = 30_000;

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/gateio' })
export class GateioGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(GateioGateway.name);

  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private intentionalClose = false;
  private clientCount = 0;

  afterInit() {
    this.logger.log('Gate.io WebSocket gateway initialized');
  }

  handleConnection(_client: Socket) {
    this.clientCount++;
    if (this.clientCount === 1) this.connectToGateio();
  }

  handleDisconnect(_client: Socket) {
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount === 0) this.disconnectFromGateio();
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket) {
    client.emit('pong');
  }

  private connectToGateio() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.intentionalClose = false;

    this.logger.log('Connecting to Gate.io WebSocket...');
    this.ws = new WebSocket(GATEIO_WS_URL);

    this.ws.on('open', () => {
      this.logger.log('Gate.io WebSocket connected');
      this.reconnectDelay = RECONNECT_DELAY;
      this.subscribe();
      this.startPing();
      this.server.emit('ws_status', { connected: true });
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleGateioMessage(msg);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('close', (code) => {
      this.logger.warn(`Gate.io WebSocket closed (code: ${code})`);
      this.stopPing();
      this.server.emit('ws_status', { connected: false });
      if (!this.intentionalClose && this.clientCount > 0) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`Gate.io WebSocket error: ${err.message}`);
    });
  }

  private subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const ts = Math.floor(Date.now() / 1000);

    // Ticker
    this.ws.send(JSON.stringify({
      time: ts,
      channel: 'spot.tickers',
      event: 'subscribe',
      payload: [SYMBOL],
    }));

    // Order book (snapshot + updates)
    this.ws.send(JSON.stringify({
      time: ts,
      channel: 'spot.order_book',
      event: 'subscribe',
      payload: [SYMBOL, '20', '100ms'],
    }));

    // Trades
    this.ws.send(JSON.stringify({
      time: ts,
      channel: 'spot.trades',
      event: 'subscribe',
      payload: [SYMBOL],
    }));
  }

  private handleGateioMessage(msg: any) {
    // Ping-pong: Gate.io sends {"channel":"spot.ping"} — respond with pong
    if (msg.channel === 'spot.ping' || msg.event === 'ping') {
      this.ws?.send(JSON.stringify({
        time: Math.floor(Date.now() / 1000),
        channel: 'spot.pong',
      }));
      return;
    }

    // Subscription ack
    if (msg.event === 'subscribe' || msg.event === 'unsubscribe') return;

    const channel: string = msg.channel ?? '';
    const result = msg.result;
    if (!result) return;

    if (channel === 'spot.tickers') {
      this.server.emit('ticker', {
        symbol: SYMBOL,
        price:  parseFloat(result.last          ?? '0'),
        change: parseFloat(result.change_percentage ?? '0'),
        high:   parseFloat(result.high_24h       ?? '0'),
        low:    parseFloat(result.low_24h        ?? '0'),
        volume: parseFloat(result.base_volume    ?? '0'),
      });
    } else if (channel === 'spot.order_book') {
      const bids = (result.bids as string[][] ?? []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
      const asks = (result.asks as string[][] ?? []).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
      this.server.emit('orderbook', { bids, asks, full: msg.event === 'all' });
    } else if (channel === 'spot.trades') {
      const trades = Array.isArray(result) ? result : [result];
      this.server.emit('trades', trades.map((t: any) => ({
        price: parseFloat(t.price),
        qty:   parseFloat(t.amount),
        time:  Math.floor(parseFloat(t.create_time_ms ?? t.create_time) / (t.create_time_ms ? 1 : 1000) * (t.create_time_ms ? 1 : 1000)),
        side:  t.side === 'sell' ? 'SELL' : 'BUY',
      })));
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({
        time: Math.floor(Date.now() / 1000),
        channel: 'spot.ping',
      }));
    }, PING_INTERVAL);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.logger.log(`Reconnecting to Gate.io in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToGateio();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, this.reconnectDelay);
  }

  private disconnectFromGateio() {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.terminate();
    this.ws = null;
  }

  onModuleDestroy() {
    this.disconnectFromGateio();
  }
}
