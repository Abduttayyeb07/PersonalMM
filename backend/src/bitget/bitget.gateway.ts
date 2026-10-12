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

const WS_URL            = 'wss://ws.bitget.com/v2/ws/public';
const SYMBOL            = 'ZIGUSDT';
const HEARTBEAT_MS      = 25_000;
const PONG_TIMEOUT_MS   = 10_000;
const RECONNECT_DELAY   = 3_000;
const MAX_RECONNECT_DELAY = 30_000;

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/bitget' })
export class BitgetGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(BitgetGateway.name);

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private intentionalClose = false;
  private clientCount = 0;

  afterInit() {
    this.logger.log('Bitget WebSocket gateway initialized');
  }

  handleConnection(_client: Socket) {
    this.clientCount++;
    if (this.clientCount === 1) this.connectToBitget();
  }

  handleDisconnect(_client: Socket) {
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount === 0) this.disconnectFromBitget();
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket) {
    client.emit('pong');
  }

  private connectToBitget() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.intentionalClose = false;

    this.logger.log('Connecting to Bitget WebSocket...');
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      this.logger.log('Bitget WebSocket connected');
      this.reconnectDelay = RECONNECT_DELAY;
      this.subscribe();
      this.startHeartbeat();
      this.server.emit('ws_status', { connected: true });
    });

    this.ws.on('message', (raw: Buffer) => {
      const text = raw.toString();

      // Bitget heartbeat: plain string "pong"
      if (text === 'pong') {
        this.clearPongTimer();
        return;
      }

      try {
        const msg = JSON.parse(text);

        // Subscription ACK
        if (msg.event === 'subscribe' || msg.event === 'error') return;

        if (msg.data && msg.arg?.channel) {
          this.handleBitgetMessage(msg);
        }
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('close', (code) => {
      this.logger.warn(`Bitget WebSocket closed (code: ${code})`);
      this.stopHeartbeat();
      this.clearPongTimer();
      this.server.emit('ws_status', { connected: false });
      if (!this.intentionalClose && this.clientCount > 0) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`Bitget WebSocket error: ${err.message}`);
    });
  }

  private subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const args = [
      { instType: 'SPOT', channel: 'ticker', instId: SYMBOL },
      { instType: 'SPOT', channel: 'books15', instId: SYMBOL },
      { instType: 'SPOT', channel: 'trade',  instId: SYMBOL },
    ];
    this.ws.send(JSON.stringify({ op: 'subscribe', args }));
  }

  private handleBitgetMessage(msg: any) {
    const channel: string = msg.arg?.channel ?? '';
    const data = msg.data;

    if (channel === 'ticker') {
      const t = Array.isArray(data) ? data[0] : data;
      if (!t) return;
      const price  = parseFloat(t.lastPr ?? t.close ?? '0');
      const change = parseFloat(t.change24h ?? '0'); // decimal ratio
      this.server.emit('ticker', {
        symbol: SYMBOL,
        price,
        change,
        high:   parseFloat(t.high24h    ?? '0'),
        low:    parseFloat(t.low24h     ?? '0'),
        volume: parseFloat(t.baseVolume ?? '0'),
      });
    } else if (channel === 'books15' || channel === 'books5') {
      const book = Array.isArray(data) ? data[0] : data;
      if (!book) return;
      const bids = (book.bids ?? []).map((b: string[]) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
      const asks = (book.asks ?? []).map((a: string[]) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
      this.server.emit('orderbook', { bids, asks, full: true });
    } else if (channel === 'trade') {
      const trades = (Array.isArray(data) ? data : [data]).map((t: any) => ({
        price: parseFloat(t.price),
        qty:   parseFloat(t.size),
        time:  parseInt(t.ts, 10),
        side:  t.side === 'buy' ? 'BUY' : 'SELL',
      }));
      this.server.emit('trades', trades);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // Bitget heartbeat: plain string "ping"
      this.ws.send('ping');
      this.pongTimer = setTimeout(() => {
        this.logger.warn('No pong from Bitget — forcing reconnect');
        this.ws?.terminate();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.clearPongTimer();
  }

  private clearPongTimer() {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.logger.log(`Reconnecting to Bitget in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToBitget();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, this.reconnectDelay);
  }

  private disconnectFromBitget() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.ws?.terminate();
    this.ws = null;
  }

  onModuleDestroy() {
    this.disconnectFromBitget();
  }
}
