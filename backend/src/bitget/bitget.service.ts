import { Injectable, BadRequestException, BadGatewayException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import { PrecisionEngine } from '../exchange/precision.engine';
import { ExecutionLogService } from '../execution-log/execution-log.service';
import { generateClientOid } from '../exchange/client-oid.util';
import { INTERNAL_SYMBOL } from '../exchange/types';

const BASE_URL = 'https://api.bitget.com';
const SYMBOL   = 'ZIGUSDT';

export interface BitgetCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

@Injectable()
export class BitgetService {
  private readonly logger = new Logger(BitgetService.name);

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
    creds: BitgetCredentials,
  ): Record<string, string> {
    const ts = Date.now().toString();
    const preSign = `${ts}${method.toUpperCase()}${path}${body}`;
    return {
      'ACCESS-KEY':       creds.apiKey,
      'ACCESS-SIGN':      this.sign(preSign, creds.apiSecret),
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': creds.passphrase,   // plain text, not signed
      'Content-Type': 'application/json',
      'locale': 'en-US',
    };
  }

  private client(): AxiosInstance {
    return axios.create({ baseURL: BASE_URL, timeout: 10_000 });
  }

  private unwrap<T>(data: any, context: string): T {
    if (data.code !== '00000') {
      this.logger.error(`[${context}] Bitget error ${data.code}: ${data.msg}`);
      throw new BadGatewayException({ message: data.msg ?? 'Bitget API error', bitgetCode: data.code });
    }
    return data.data as T;
  }

  private throwError(err: unknown, context: string): never {
    if (isAxiosError(err)) {
      const msg  = err.response?.data?.msg  ?? err.message;
      const code = err.response?.data?.code;
      this.logger.error(`[${context}] HTTP error: ${msg} (code=${code})`);
      throw new BadGatewayException({ message: msg, bitgetCode: code });
    }
    throw err;
  }

  // ── Public market data ───────────────────────────────────────────────────

  async getTicker() {
    try {
      const { data } = await this.client().get(
        `/api/v2/spot/market/tickers?symbol=${SYMBOL}`,
      );
      const list = this.unwrap<any[]>(data, 'getTicker');
      const t    = list[0];
      if (!t) throw new BadRequestException('No ticker data returned');

      const price  = parseFloat(t.lastPr ?? t.close ?? '0');
      const change = parseFloat(t.change24h ?? '0');   // Bitget: decimal ratio (e.g. 0.012 = 1.2%)

      return {
        symbol: SYMBOL,
        price,
        priceChange: price * change,
        priceChangePercent: change * 100,
        high:        parseFloat(t.high24h      ?? '0'),
        low:         parseFloat(t.low24h       ?? '0'),
        volume:      parseFloat(t.baseVolume   ?? '0'),
        quoteVolume: parseFloat(t.quoteVolume  ?? '0'),
      };
    } catch (err) {
      this.throwError(err, 'getTicker');
    }
  }

  async getOrderBook(limit = 20) {
    try {
      const { data } = await this.client().get(
        `/api/v2/spot/market/orderbook?symbol=${SYMBOL}&type=step0&limit=${limit}`,
      );
      const r = this.unwrap<{ asks: string[][]; bids: string[][] }>(data, 'getOrderBook');
      return {
        bids: (r.bids ?? []).map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
        asks: (r.asks ?? []).map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
      };
    } catch (err) {
      this.throwError(err, 'getOrderBook');
    }
  }

  async getRecentTrades(limit = 20) {
    try {
      const { data } = await this.client().get(
        `/api/v2/spot/market/fills?symbol=${SYMBOL}&limit=${limit}`,
      );
      const r = this.unwrap<any[]>(data, 'getRecentTrades');
      return r.map((t) => ({
        id:          t.tradeId,
        price:       parseFloat(t.price),
        qty:         parseFloat(t.size),
        time:        parseInt(t.ts, 10),
        isBuyerMaker: t.side === 'sell',
      }));
    } catch (err) {
      this.throwError(err, 'getRecentTrades');
    }
  }

  // ── Authenticated ────────────────────────────────────────────────────────

  async validateCredentials(creds: BitgetCredentials): Promise<boolean> {
    try {
      const path = '/api/v2/spot/account/assets';
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      return data.code === '00000';
    } catch {
      return false;
    }
  }

  async getBalances(creds: BitgetCredentials) {
    try {
      const path = '/api/v2/spot/account/assets';
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const list = this.unwrap<any[]>(data, 'getBalances');
      return list
        .filter((a) => parseFloat(a.available ?? '0') + parseFloat(a.frozen ?? '0') + parseFloat(a.locked ?? '0') > 0)
        .map((a) => ({
          asset:  a.coin ?? a.coinName,   // V2 uses 'coin', V1 used 'coinName'
          free:   parseFloat(a.available ?? '0'),
          locked: parseFloat(a.frozen    ?? '0') + parseFloat(a.locked ?? '0'),
        }));
    } catch (err) {
      this.throwError(err, 'getBalances');
    }
  }

  private normalizeOrder(o: any) {
    const statusMap: Record<string, string> = {
      live:             'NEW',
      partially_filled: 'PARTIALLY_FILLED',
      filled:           'FILLED',
      cancelled:        'CANCELED',
      canceled:         'CANCELED',
    };
    const isMarketBuy = o.orderType === 'market' && o.side === 'buy';
    // For market BUY we send size=USDT; origQty should always be in base (ZIG)
    // so use baseVolume (filled ZIG) as the canonical quantity for market buys
    const origQty     = isMarketBuy ? (o.baseVolume ?? '0') : (o.size ?? '0');
    const executedQty = o.baseVolume ?? '0';
    const quoteQty    = o.quoteVolume ?? '0';

    // Bitget may use different field names for limit price across endpoints
    const rawPrice = o.price || o.orderPrice || o.enterPrice || o.priceAvg || '0';
    const priceNum = parseFloat(rawPrice);
    const price    = isNaN(priceNum) || priceNum === 0 ? '0' : rawPrice;

    // If quoteVolume is zero but we have price + executedQty, compute it
    const computedQuote =
      parseFloat(quoteQty) > 0
        ? quoteQty
        : priceNum > 0
          ? (parseFloat(executedQty) * priceNum).toFixed(8)
          : '0';

    return {
      orderId:             o.orderId,
      symbol:              o.symbol,
      side:                (o.side as string).toUpperCase(),
      type:                o.orderType?.toUpperCase() ?? 'LIMIT',
      origQty,
      price,
      executedQty,
      cummulativeQuoteQty: computedQuote,
      status:              statusMap[o.status] ?? 'NEW',
      time:                parseInt(o.cTime   ?? '0', 10),
      updateTime:          parseInt(o.uTime   ?? o.cTime ?? '0', 10),
    };
  }

  async getOpenOrders(creds: BitgetCredentials) {
    try {
      const path = `/api/v2/spot/trade/unfilled-orders?symbol=${SYMBOL}`;
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const r = this.unwrap<any>(data, 'getOpenOrders');
      const list: any[] = Array.isArray(r) ? r : (r?.entrustedList ?? r?.orders ?? []);
      return list.map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOpenOrders');
    }
  }

  async getOrderHistory(creds: BitgetCredentials, limit = 30) {
    try {
      const path = `/api/v2/spot/trade/history-orders?symbol=${SYMBOL}&limit=${limit}`;
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const r = this.unwrap<any>(data, 'getOrderHistory');
      const list: any[] = Array.isArray(r) ? r : (r?.orderList ?? r?.orders ?? []);
      return list.map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOrderHistory');
    }
  }

  async placeOrder(
    userId: string,
    creds: BitgetCredentials,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: string,
    price?: string,
    quoteOrderQty?: string,
  ) {
    if (type === 'LIMIT' && !price) {
      throw new BadRequestException('Price required for LIMIT orders');
    }

    const { baseIncrement, quoteIncrement } = await this.precision.get('bitget', INTERNAL_SYMBOL);
    const clientOrderId = generateClientOid('bitget');

    const body: Record<string, any> = {
      symbol:    SYMBOL,
      side:      side.toLowerCase(),
      orderType: type.toLowerCase(),
      clientOid: clientOrderId,
    };

    if (type === 'LIMIT') {
      body.force = 'gtc';
      body.price = this.precision.round(price!, quoteIncrement);
      body.size  = this.precision.round(quantity, baseIncrement);
    } else {
      // Bitget V2 market orders: size = USDT amount for BUY, ZIG amount for SELL
      if (side === 'BUY' && quoteOrderQty) {
        body.size = this.precision.round(quoteOrderQty, quoteIncrement);
      } else {
        body.size = this.precision.round(quantity, baseIncrement);
      }
    }

    const sizeVal = parseFloat(body.size ?? '0');
    if (!sizeVal || sizeVal <= 0) {
      throw new BadRequestException('Order size must be greater than 0');
    }

    const log = await this.execLog.startOrder({
      userId, exchange: 'bitget', symbol: INTERNAL_SYMBOL,
      side, type, quantity: body.size, price: body.price,
      quoteQty: body.quoteSize, clientOrderId,
    });

    const path    = '/api/v2/spot/trade/place-order';
    const bodyStr = JSON.stringify(body);
    const t0      = Date.now();
    try {
      const { data } = await this.client().post(path, body, {
        headers: this.authHeaders('POST', path, bodyStr, creds),
      });
      const result = this.unwrap<any>(data, 'placeOrder');
      await log.resolve(result?.orderId ?? '', Date.now() - t0);
      return result;
    } catch (err) {
      await log.reject(
        isAxiosError(err) ? (err.response?.data?.msg ?? err.message) : String(err),
        Date.now() - t0,
      );
      this.throwError(err, 'placeOrder');
    }
  }

  async cancelOrder(creds: BitgetCredentials, orderId: string) {
    const path    = '/api/v2/spot/trade/cancel-order';
    const body    = { symbol: SYMBOL, orderId };
    const bodyStr = JSON.stringify(body);
    try {
      const { data } = await this.client().post(path, body, {
        headers: this.authHeaders('POST', path, bodyStr, creds),
      });
      return this.unwrap(data, 'cancelOrder');
    } catch (err) {
      this.throwError(err, 'cancelOrder');
    }
  }

  async getOrderStatus(creds: BitgetCredentials, orderId: string) {
    try {
      const path = `/api/v2/spot/trade/orderInfo?symbol=${SYMBOL}&orderId=${orderId}`;
      const { data } = await this.client().get(path, {
        headers: this.authHeaders('GET', path, '', creds),
      });
      const list = this.unwrap<any[]>(data, 'getOrderStatus');
      return list?.[0] ? this.normalizeOrder(list[0]) : null;
    } catch (err) {
      this.throwError(err, 'getOrderStatus');
    }
  }
}
