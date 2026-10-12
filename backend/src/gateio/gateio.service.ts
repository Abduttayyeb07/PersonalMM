import { Injectable, BadRequestException, BadGatewayException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import axios, { isAxiosError } from 'axios';
import { PrecisionEngine } from '../exchange/precision.engine';
import { ExecutionLogService } from '../execution-log/execution-log.service';
import { generateClientOid } from '../exchange/client-oid.util';
import { INTERNAL_SYMBOL } from '../exchange/types';
import { normalizeOrderStatus } from '../exchange/order-state.util';

const BASE_URL = 'https://api.gateio.ws';
const SYMBOL   = 'ZIG_USDT';

export interface GateioCredentials {
  apiKey: string;
  apiSecret: string;
}

@Injectable()
export class GateioService {
  private readonly logger = new Logger(GateioService.name);

  constructor(
    private precision: PrecisionEngine,
    private execLog: ExecutionLogService,
  ) {}

  // ── Auth ─────────────────────────────────────────────────────────────────
  // Gate.io v4 signature: HMAC-SHA512 of
  //   "{METHOD}\n{PATH}\n{QUERY}\n{SHA512(BODY)}\n{TIMESTAMP}"

  private bodyHash(body: string): string {
    return crypto.createHash('sha512').update(body).digest('hex');
  }

  private sign(
    method: string,
    path: string,
    query: string,
    body: string,
    ts: string,
    secret: string,
  ): string {
    const msg = `${method}\n${path}\n${query}\n${this.bodyHash(body)}\n${ts}`;
    return crypto.createHmac('sha512', secret).update(msg).digest('hex');
  }

  private authHeaders(
    method: string,
    path: string,
    query: string,
    body: string,
    creds: GateioCredentials,
  ): Record<string, string> {
    const ts  = Math.floor(Date.now() / 1000).toString();
    const sig = this.sign(method, path, query, body, ts, creds.apiSecret);
    return {
      'KEY':           creds.apiKey,
      'SIGN':          sig,
      'Timestamp':     ts,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    };
  }

  private throwError(err: unknown, context: string): never {
    if (isAxiosError(err)) {
      const msg  = err.response?.data?.message ?? err.response?.data?.label ?? err.message;
      const code = err.response?.data?.label;
      this.logger.error(`[${context}] ${msg} (label=${code})`);
      throw new BadGatewayException({ message: msg, gateCode: code });
    }
    throw err;
  }

  // ── Public market data ───────────────────────────────────────────────────

  async getTicker() {
    try {
      const { data } = await axios.get(
        `${BASE_URL}/api/v4/spot/tickers?currency_pair=${SYMBOL}`,
        { timeout: 10_000 },
      );
      const t = data[0];
      if (!t) throw new BadRequestException('Ticker not found');

      const last = parseFloat(t.last ?? '0');
      const open = parseFloat(t.open ?? '0'); // Gate uses open_24h sometimes
      const changePct = parseFloat(t.change_percentage ?? '0');

      return {
        symbol:             SYMBOL,
        price:              last,
        priceChange:        last - open,
        priceChangePercent: changePct,
        high:               parseFloat(t.high_24h  ?? '0'),
        low:                parseFloat(t.low_24h   ?? '0'),
        volume:             parseFloat(t.base_volume  ?? '0'),
        quoteVolume:        parseFloat(t.quote_volume ?? '0'),
      };
    } catch (err) {
      this.throwError(err, 'getTicker');
    }
  }

  async getOrderBook(limit = 20) {
    try {
      const { data } = await axios.get(
        `${BASE_URL}/api/v4/spot/order_book?currency_pair=${SYMBOL}&limit=${limit}`,
        { timeout: 10_000 },
      );
      return {
        bids: (data.bids as string[][]).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
        asks: (data.asks as string[][]).map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      };
    } catch (err) {
      this.throwError(err, 'getOrderBook');
    }
  }

  async getRecentTrades(limit = 20) {
    try {
      const { data } = await axios.get(
        `${BASE_URL}/api/v4/spot/trades?currency_pair=${SYMBOL}&limit=${limit}`,
        { timeout: 10_000 },
      );
      return (data as any[]).map((t) => ({
        id:           String(t.id),
        price:        parseFloat(t.price),
        qty:          parseFloat(t.amount),
        time:         Math.floor(parseFloat(t.create_time_ms ?? t.create_time) / (t.create_time_ms ? 1 : 1000) * (t.create_time_ms ? 1 : 1000)),
        isBuyerMaker: t.side === 'sell', // sell taker = buyer is maker
      }));
    } catch (err) {
      this.throwError(err, 'getRecentTrades');
    }
  }

  // ── Authenticated ────────────────────────────────────────────────────────

  async validateCredentials(creds: GateioCredentials): Promise<boolean> {
    try {
      const path  = '/api/v4/spot/accounts';
      const query = `currency=USDT`;
      const { data } = await axios.get(`${BASE_URL}${path}?${query}`, {
        headers: this.authHeaders('GET', path, query, '', creds),
        timeout: 10_000,
      });
      return Array.isArray(data);
    } catch {
      return false;
    }
  }

  async getBalances(creds: GateioCredentials) {
    try {
      const path = '/api/v4/spot/accounts';
      const { data } = await axios.get(`${BASE_URL}${path}`, {
        headers: this.authHeaders('GET', path, '', '', creds),
        timeout: 10_000,
      });
      return (data as any[])
        .filter((a) => parseFloat(a.available ?? '0') > 0 || parseFloat(a.locked ?? '0') > 0)
        .map((a) => ({
          asset:  a.currency,
          free:   parseFloat(a.available ?? '0'),
          locked: parseFloat(a.locked    ?? '0'),
        }));
    } catch (err) {
      this.throwError(err, 'getBalances');
    }
  }

  private normalizeOrder(o: any) {
    const filledAmt  = parseFloat(o.filled_amount  ?? o.amount ?? '0');
    const totalAmt   = parseFloat(o.amount         ?? '0');
    const filledTotal = parseFloat(o.filled_total  ?? '0');

    return {
      orderId:              String(o.id),
      clientOrderId:        o.text?.replace(/^t-/, '') ?? '',
      symbol:               o.currency_pair,
      side:                 (o.side as string).toUpperCase(),
      type:                 (o.type as string).toUpperCase(),
      origQty:              String(totalAmt),
      price:                o.price ?? '0',
      executedQty:          String(filledAmt),
      cummulativeQuoteQty:  String(filledTotal),
      status:               normalizeOrderStatus('gateio', o.status),
      time:                 Math.floor(parseFloat(o.create_time_ms ?? o.create_time) / (o.create_time_ms ? 1 : 1) * (o.create_time_ms ? 1 : 1000)),
      updateTime:           Math.floor(parseFloat(o.update_time_ms ?? o.update_time ?? o.create_time) / (o.update_time_ms ? 1 : 1) * (o.update_time_ms ? 1 : 1000)),
    };
  }

  async getOpenOrders(creds: GateioCredentials) {
    try {
      const path  = '/api/v4/spot/orders';
      const query = `currency_pair=${SYMBOL}&status=open`;
      const { data } = await axios.get(`${BASE_URL}${path}?${query}`, {
        headers: this.authHeaders('GET', path, query, '', creds),
        timeout: 10_000,
      });
      return (data as any[]).map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOpenOrders');
    }
  }

  async getOrderHistory(creds: GateioCredentials, limit = 30) {
    try {
      const path  = '/api/v4/spot/orders';
      const query = `currency_pair=${SYMBOL}&status=finished&limit=${limit}`;
      const { data } = await axios.get(`${BASE_URL}${path}?${query}`, {
        headers: this.authHeaders('GET', path, query, '', creds),
        timeout: 10_000,
      });
      return (data as any[]).map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOrderHistory');
    }
  }

  async placeOrder(
    userId: string,
    creds: GateioCredentials,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: string,
    price?: string,
    quoteOrderQty?: string,
  ) {
    if (type === 'LIMIT' && !price) {
      throw new BadRequestException('Price required for LIMIT orders');
    }

    const { baseIncrement, quoteIncrement } = await this.precision.get('gateio', INTERNAL_SYMBOL);
    const clientOrderId = generateClientOid('gateio');

    const body: Record<string, any> = {
      text:          `t-${clientOrderId}`.slice(0, 30),
      currency_pair: SYMBOL,
      type:          type === 'LIMIT' ? 'limit' : 'market',
      account:       'spot',
      side:          side.toLowerCase(),
    };

    if (type === 'LIMIT') {
      body.price  = this.precision.round(price!, quoteIncrement);
      body.amount = this.precision.round(quantity, baseIncrement);
      body.time_in_force = 'gtc';
    } else {
      // Gate market BUY: amount = USDT to spend  (quote)
      // Gate market SELL: amount = ZIG to sell   (base)
      if (side === 'BUY' && quoteOrderQty) {
        body.amount = this.precision.round(quoteOrderQty, quoteIncrement);
      } else {
        body.amount = this.precision.round(quantity, baseIncrement);
      }
      // Gate.io defaults time_in_force to 'gtc' when omitted, which is invalid for market orders
      body.time_in_force = 'ioc';
    }

    const bodyStr = JSON.stringify(body);
    const path    = '/api/v4/spot/orders';

    const log = await this.execLog.startOrder({
      userId, exchange: 'gateio', symbol: INTERNAL_SYMBOL,
      side, type, quantity: body.amount, price: body.price,
      quoteQty: type === 'MARKET' && side === 'BUY' ? body.amount : undefined,
      clientOrderId,
    });

    const t0 = Date.now();
    try {
      const { data } = await axios.post(`${BASE_URL}${path}`, body, {
        headers: this.authHeaders('POST', path, '', bodyStr, creds),
        timeout: 10_000,
      });
      await log.resolve(String(data.id ?? ''), Date.now() - t0);
      return this.normalizeOrder(data);
    } catch (err) {
      await log.reject(
        isAxiosError(err) ? (err.response?.data?.message ?? err.message) : String(err),
        Date.now() - t0,
      );
      this.throwError(err, 'placeOrder');
    }
  }

  async cancelOrder(creds: GateioCredentials, orderId: string) {
    try {
      const path  = `/api/v4/spot/orders/${orderId}`;
      const query = `currency_pair=${SYMBOL}`;
      const { data } = await axios.delete(`${BASE_URL}${path}?${query}`, {
        headers: this.authHeaders('DELETE', path, query, '', creds),
        timeout: 10_000,
      });
      return this.normalizeOrder(data);
    } catch (err) {
      this.throwError(err, 'cancelOrder');
    }
  }

  async getOrderStatus(creds: GateioCredentials, orderId: string) {
    try {
      const path  = `/api/v4/spot/orders/${orderId}`;
      const query = `currency_pair=${SYMBOL}`;
      const { data } = await axios.get(`${BASE_URL}${path}?${query}`, {
        headers: this.authHeaders('GET', path, query, '', creds),
        timeout: 10_000,
      });
      return this.normalizeOrder(data);
    } catch (err) {
      this.throwError(err, 'getOrderStatus');
    }
  }
}
