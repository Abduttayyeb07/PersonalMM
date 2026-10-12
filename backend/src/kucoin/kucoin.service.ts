import { Injectable, BadRequestException, BadGatewayException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import { PrecisionEngine } from '../exchange/precision.engine';
import { ExecutionLogService } from '../execution-log/execution-log.service';
import { generateClientOid } from '../exchange/client-oid.util';
import { INTERNAL_SYMBOL } from '../exchange/types';

const BASE_URL = 'https://api.kucoin.com';
const SYMBOL = 'ZIG-USDT';

export interface KucoinCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

@Injectable()
export class KucoinService {
  private readonly logger = new Logger(KucoinService.name);

  constructor(
    private precision: PrecisionEngine,
    private execLog: ExecutionLogService,
  ) {}

  // ── Auth ─────────────────────────────────────────────────────────────────

  private sign(str: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(str).digest('base64');
  }

  private authHeaders(
    method: string,
    path: string,
    body: string,
    creds: KucoinCredentials,
  ): Record<string, string> {
    const ts = Date.now().toString();
    const preSign = `${ts}${method}${path}${body}`;
    const signature = this.sign(preSign, creds.apiSecret);
    const passphraseEnc = this.sign(creds.passphrase, creds.apiSecret);
    return {
      'KC-API-KEY': creds.apiKey,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': ts,
      'KC-API-PASSPHRASE': passphraseEnc,
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json',
    };
  }

  private client(): AxiosInstance {
    return axios.create({ baseURL: BASE_URL, timeout: 10_000 });
  }

  private unwrap<T>(data: any, context: string): T {
    if (data.code !== '200000') {
      this.logger.error(`[${context}] KuCoin error ${data.code}: ${data.msg}`);
      throw new BadGatewayException({ message: data.msg, kucoinCode: data.code });
    }
    return data.data as T;
  }

  private throwError(err: unknown, context: string): never {
    if (isAxiosError(err)) {
      const msg = err.response?.data?.msg ?? err.message;
      const code = err.response?.data?.code;
      this.logger.error(`[${context}] HTTP error: ${msg} (code=${code})`);
      throw new BadGatewayException({ message: msg, kucoinCode: code });
    }
    throw err;
  }

  // ── Public market data ───────────────────────────────────────────────────

  async getTicker() {
    try {
      const { data } = await this.client().get(
        `/api/v1/market/orderbook/level1?symbol=${SYMBOL}`,
      );
      const r = this.unwrap<any>(data, 'getTicker');

      // KuCoin level1 doesn't include 24h stats; fetch stats separately
      const { data: statsData } = await this.client().get(
        `/api/v1/market/stats?symbol=${SYMBOL}`,
      );
      const s = this.unwrap<any>(statsData, 'getStats');

      const price = parseFloat(r.price ?? s.last ?? '0');
      const open = parseFloat(s.open ?? '0');

      return {
        symbol: SYMBOL,
        price,
        priceChange: price - open,
        priceChangePercent: open > 0 ? ((price - open) / open) * 100 : 0,
        high: parseFloat(s.high ?? '0'),
        low: parseFloat(s.low ?? '0'),
        volume: parseFloat(s.vol ?? '0'),
        quoteVolume: parseFloat(s.volValue ?? '0'),
      };
    } catch (err) {
      this.throwError(err, 'getTicker');
    }
  }

  async getOrderBook(limit = 20) {
    try {
      const endpoint = limit <= 20
        ? `/api/v1/market/orderbook/level2_20?symbol=${SYMBOL}`
        : `/api/v1/market/orderbook/level2_100?symbol=${SYMBOL}`;
      const { data } = await this.client().get(endpoint);
      const r = this.unwrap<{ bids: string[][]; asks: string[][] }>(data, 'getOrderBook');
      return {
        bids: r.bids.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
        asks: r.asks.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
      };
    } catch (err) {
      this.throwError(err, 'getOrderBook');
    }
  }

  async getRecentTrades(limit = 20) {
    try {
      const { data } = await this.client().get(
        `/api/v1/market/histories?symbol=${SYMBOL}`,
      );
      const r = this.unwrap<any[]>(data, 'getRecentTrades');
      return r.slice(0, limit).map((t) => ({
        id: t.sequence,
        price: parseFloat(t.price),
        qty: parseFloat(t.size),
        time: parseInt(t.time, 10) / 1_000_000, // nanoseconds → ms
        isBuyerMaker: t.side === 'sell',
      }));
    } catch (err) {
      this.throwError(err, 'getRecentTrades');
    }
  }

  // ── Authenticated ────────────────────────────────────────────────────────

  async validateCredentials(creds: KucoinCredentials): Promise<boolean> {
    try {
      const path = '/api/v1/accounts';
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      return data.code === '200000';
    } catch {
      return false;
    }
  }

  async getBalances(creds: KucoinCredentials) {
    try {
      const path = '/api/v1/accounts';
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const accounts = this.unwrap<any[]>(data, 'getBalances');

      // KuCoin has trade/main/margin account types — aggregate by currency
      const map = new Map<string, { free: number; locked: number }>();
      for (const a of accounts) {
        const balance = parseFloat(a.balance ?? '0');
        const available = parseFloat(a.available ?? '0');
        const holds = parseFloat(a.holds ?? '0');
        if (balance <= 0) continue;
        const existing = map.get(a.currency) ?? { free: 0, locked: 0 };
        // trade accounts: available = free, holds = locked
        // main accounts: all available (no holds in orders)
        if (a.type === 'trade') {
          map.set(a.currency, {
            free: existing.free + available,
            locked: existing.locked + holds,
          });
        } else {
          // main/other — show as free
          map.set(a.currency, {
            free: existing.free + available,
            locked: existing.locked,
          });
        }
      }

      return Array.from(map.entries())
        .map(([asset, { free, locked }]) => ({ asset, free, locked }));
    } catch (err) {
      this.throwError(err, 'getBalances');
    }
  }

  private normalizeOrder(o: any) {
    const statusMap: Record<string, string> = {
      open: 'NEW',
      done: o.dealFunds > 0 ? 'FILLED' : 'CANCELED',
      active: 'NEW',
      cancelled: 'CANCELED',
    };
    return {
      orderId: o.id,
      symbol: o.symbol,
      side: (o.side as string).toUpperCase(),
      type: (o.type as string).toUpperCase(),
      origQty: o.size,
      price: o.price,
      executedQty: o.dealSize ?? '0',
      cummulativeQuoteQty: o.dealFunds ?? '0',
      status: statusMap[o.status] ?? 'NEW',
      time: o.createdAt,
      updateTime: o.updatedAt ?? o.createdAt,
    };
  }

  async getOpenOrders(creds: KucoinCredentials) {
    try {
      const path = `/api/v1/orders?status=active&symbol=${SYMBOL}`;
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const r = this.unwrap<{ items: any[] }>(data, 'getOpenOrders');
      return (r.items ?? []).map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOpenOrders');
    }
  }

  async getOrderHistory(creds: KucoinCredentials, limit = 30) {
    try {
      const path = `/api/v1/orders?status=done&symbol=${SYMBOL}&pageSize=${limit}`;
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const r = this.unwrap<{ items: any[] }>(data, 'getOrderHistory');
      return (r.items ?? []).map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOrderHistory');
    }
  }

  async placeOrder(
    userId: string,
    creds: KucoinCredentials,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: string,
    price?: string,
    quoteOrderQty?: string,
  ) {
    if (type === 'LIMIT' && !price) {
      throw new BadRequestException('Price required for LIMIT orders');
    }

    const { baseIncrement, quoteIncrement } = await this.precision.get('kucoin', INTERNAL_SYMBOL);
    const clientOrderId = generateClientOid('kucoin');

    const path = '/api/v1/orders';
    const body: Record<string, any> = {
      clientOid: clientOrderId,
      side: side.toLowerCase(),
      symbol: SYMBOL,
      type: type.toLowerCase(),
    };

    if (type === 'LIMIT') {
      body.price = this.precision.round(price!, quoteIncrement);
      body.size = this.precision.round(quantity, baseIncrement);
    } else {
      if (side === 'BUY' && quoteOrderQty) {
        body.funds = this.precision.round(quoteOrderQty, quoteIncrement);
      } else {
        body.size = this.precision.round(quantity, baseIncrement);
      }
    }

    const log = await this.execLog.startOrder({
      userId, exchange: 'kucoin', symbol: INTERNAL_SYMBOL,
      side, type, quantity: body.size, price: body.price,
      quoteQty: body.funds, clientOrderId,
    });

    const bodyStr = JSON.stringify(body);
    const t0 = Date.now();
    try {
      const { data } = await this.client().post(path, body, {
        headers: this.authHeaders('POST', path, bodyStr, creds),
      });
      const result = this.unwrap<any>(data, 'placeOrder');
      await log.resolve(result?.orderId ?? '', Date.now() - t0);
      return result;
    } catch (err) {
      await log.reject(isAxiosError(err) ? (err.response?.data?.msg ?? err.message) : String(err), Date.now() - t0);
      this.throwError(err, 'placeOrder');
    }
  }

  async cancelOrder(creds: KucoinCredentials, orderId: string) {
    const path = `/api/v1/orders/${orderId}`;
    try {
      const { data } = await this.client().delete(path, {
        headers: this.authHeaders('DELETE', path, '', creds),
      });
      return this.unwrap(data, 'cancelOrder');
    } catch (err) {
      this.throwError(err, 'cancelOrder');
    }
  }

  async getOrderStatus(creds: KucoinCredentials, orderId: string) {
    try {
      const path = `/api/v1/orders/${orderId}`;
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const r = this.unwrap<any>(data, 'getOrderStatus');
      return r ?? null;
    } catch (err) {
      this.throwError(err, 'getOrderStatus');
    }
  }
}
