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
import axios from 'axios';

const KUCOIN_REST = 'https://api.kucoin.com';
const SYMBOL = 'ZIG-USDT';
const HEARTBEAT_INTERVAL = 18_000; // KuCoin ping interval: every 18s
const PONG_TIMEOUT = 10_000;
const RECONNECT_DELAY = 3_000;
const MAX_RECONNECT_DELAY = 30_000;

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/kucoin' })
export class KucoinGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(KucoinGateway.name);

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_DELAY;
  private intentionalClose = false;
  private clientCount = 0;
  private wsToken: string | null = null;
  private wsEndpoint: string | null = null;
  private pingId = 0;

  afterInit() {
    this.logger.log('KuCoin WebSocket gateway initialized');
  }

  handleConnection(_client: Socket) {
    this.clientCount++;
    if (this.clientCount === 1) this.connectToKucoin();
  }

  handleDisconnect(_client: Socket) {
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount === 0) this.disconnectFromKucoin();
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket) {
    client.emit('pong');
  }

  private async fetchToken(): Promise<{ endpoint: string; token: string } | null> {
    try {
      const { data } = await axios.post(`${KUCOIN_REST}/api/v1/bullet-public`);
      if (data.code !== '200000') return null;
      const server = data.data.instanceServers[0];
      return {
        endpoint: server.endpoint,
        token: data.data.token,
      };
    } catch (err) {
      this.logger.error(`Failed to fetch KuCoin WS token: ${err}`);
      return null;
    }
  }

  private async connectToKucoin() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.intentionalClose = false;

    const tokenData = await this.fetchToken();
    if (!tokenData) {
      this.logger.error('Could not get KuCoin WS token — retrying later');
      this.scheduleReconnect();
      return;
    }

    this.wsToken = tokenData.token;
    this.wsEndpoint = tokenData.endpoint;

    const wsUrl = `${tokenData.endpoint}?token=${tokenData.token}&connectId=${Date.now()}`;
    this.logger.log('Connecting to KuCoin WebSocket...');
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.logger.log('KuCoin WebSocket connected');
      this.reconnectDelay = RECONNECT_DELAY;
      this.subscribe();
      this.startHeartbeat();
      this.server.emit('ws_status', { connected: true });
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        // KuCoin welcome message
        if (msg.type === 'welcome') return;

        // KuCoin ack / pong
        if (msg.type === 'ack' || msg.type === 'pong') {
          this.clearPongTimer();
          return;
        }

        // KuCoin server-initiated ping — respond
        if (msg.type === 'ping') {
          this.ws?.send(JSON.stringify({ id: msg.id, type: 'pong' }));
          return;
        }

        if (msg.type === 'message' && msg.topic) {
          this.handleKucoinMessage(msg);
        }
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('close', (code) => {
      this.logger.warn(`KuCoin WebSocket closed (code: ${code})`);
      this.stopHeartbeat();
      this.clearPongTimer();
      this.server.emit('ws_status', { connected: false });
      if (!this.intentionalClose && this.clientCount > 0) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error(`KuCoin WebSocket error: ${err.message}`);
    });
  }

  private subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Ticker
    this.ws.send(JSON.stringify({
      id: Date.now().toString(),
      type: 'subscribe',
      topic: `/market/ticker:${SYMBOL}`,
      response: true,
    }));
    // Order book (level2 depth5)
    this.ws.send(JSON.stringify({
      id: Date.now().toString(),
      type: 'subscribe',
      topic: `/spotMarket/level2Depth50:${SYMBOL}`,
      response: true,
    }));
    // Match (trades)
    this.ws.send(JSON.stringify({
      id: Date.now().toString(),
      type: 'subscribe',
      topic: `/market/match:${SYMBOL}`,
      response: true,
    }));
  }

  private handleKucoinMessage(msg: any) {
    const topic: string = msg.topic ?? '';

    if (topic.startsWith('/market/ticker:')) {
      const d = msg.data;
      if (!d) return;
      this.server.emit('ticker', {
        symbol: SYMBOL,
        price: parseFloat(d.price ?? d.lastPrice ?? '0'),
        change: parseFloat(d.changeRate ?? '0'),       // decimal ratio
        high: parseFloat(d.high ?? '0'),
        low: parseFloat(d.low ?? '0'),
        volume: parseFloat(d.vol ?? d.volume ?? '0'),
      });
    } else if (topic.startsWith('/spotMarket/level2Depth')) {
      const d = msg.data;
      if (!d) return;
      const bids = (d.bids ?? []).map((b: string[]) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
      const asks = (d.asks ?? []).map((a: string[]) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
      this.server.emit('orderbook', { bids, asks, full: true });
    } else if (topic.startsWith('/market/match:')) {
      const t = msg.data;
      if (!t) return;
      this.server.emit('trades', [{
        price: parseFloat(t.price),
        qty: parseFloat(t.size),
        time: Math.floor(parseInt(t.time, 10) / 1_000_000), // nanoseconds → ms
        side: t.side === 'buy' ? 'BUY' : 'SELL',
      }]);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const id = (++this.pingId).toString();
      this.ws.send(JSON.stringify({ id, type: 'ping' }));
      this.pongTimer = setTimeout(() => {
        this.logger.warn('No pong from KuCoin — forcing reconnect');
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
    this.logger.log(`Reconnecting to KuCoin in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToKucoin();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }, this.reconnectDelay);
  }

  private disconnectFromKucoin() {
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
    this.disconnectFromKucoin();
  }
}
