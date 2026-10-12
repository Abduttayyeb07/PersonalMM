import { Injectable, BadRequestException, BadGatewayException, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import { PrecisionEngine } from '../exchange/precision.engine';
import { ExecutionLogService } from '../execution-log/execution-log.service';
import { generateClientOid } from '../exchange/client-oid.util';
import { INTERNAL_SYMBOL } from '../exchange/types';
import { TradingSafetyService } from '../exchange/trading-safety.service';
import { PrismaService } from '../prisma/prisma.service';

const BASE_URL = 'https://api.mexc.com';
const SYMBOL = 'ZIGUSDT';

export interface MexcCredentials {
  apiKey: string;
  apiSecret: string;
}

@Injectable()
export class MexcService {
  private readonly logger = new Logger(MexcService.name);

  constructor(
    private precision: PrecisionEngine,
    private execLog: ExecutionLogService,
    private safety: TradingSafetyService,
    private prisma: PrismaService,
  ) {}

  private buildClient(apiKey: string): AxiosInstance {
    return axios.create({
      baseURL: BASE_URL,
      timeout: 10000,
      headers: { 'X-MEXC-APIKEY': apiKey, 'Content-Type': 'application/json' },
    });
  }

  private sign(queryString: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(queryString)
      .digest('hex');
  }

  private signedParams(params: Record<string, any>, secret: string): string {
    const timestamp = Date.now();
    // recvWindow gives 10s tolerance for Windows clock drift
    const merged = { ...params, timestamp, recvWindow: 10000 };
    const qs = new URLSearchParams(
      Object.entries(merged).map(([k, v]) => [k, String(v)]),
    ).toString();
    const signature = this.sign(qs, secret);
    return `${qs}&signature=${signature}`;
  }

  private throwMexcError(err: unknown): never {
    if (isAxiosError(err)) {
      const msg: string =
        err.response?.data?.msg ??
        err.response?.data?.message ??
        err.message;
      const mexcCode: number | undefined = err.response?.data?.code;
      const status: number = err.response?.status ?? 500;
      this.logger.error(`MEXC API error: ${msg} (mexcCode=${mexcCode}, http=${status})`);
      throw new BadGatewayException({ message: msg, mexcCode, status });
    }
    throw err;
  }

  async validateCredentials(creds: MexcCredentials): Promise<boolean> {
    try {
      const client = this.buildClient(creds.apiKey);
      const qs = this.signedParams({}, creds.apiSecret);
      await client.get(`/api/v3/account?${qs}`);
      return true;
    } catch (err) {
      this.logger.warn(`MEXC credential validation failed: ${isAxiosError(err) ? err.message : err}`);
      return false;
    }
  }

  async createListenKey(creds: MexcCredentials): Promise<string> {
    try {
      const client = this.buildClient(creds.apiKey);
      const qs = this.signedParams({}, creds.apiSecret);
      const { data } = await client.post(`/api/v3/userDataStream?${qs}`);
      if (!data?.listenKey) throw new Error('missing listen key');
      return data.listenKey;
    } catch {
      throw new BadGatewayException('Unable to start MEXC private stream');
    }
  }

  async keepAliveListenKey(creds: MexcCredentials, listenKey: string): Promise<void> {
    const client = this.buildClient(creds.apiKey);
    const qs = this.signedParams({ listenKey }, creds.apiSecret);
    await client.put(`/api/v3/userDataStream?${qs}`);
  }

  async deleteListenKey(creds: MexcCredentials, listenKey: string): Promise<void> {
    const client = this.buildClient(creds.apiKey);
    const qs = this.signedParams({ listenKey }, creds.apiSecret);
    await client.delete(`/api/v3/userDataStream?${qs}`);
  }

  async getBalances(creds: MexcCredentials) {
    try {
      const client = this.buildClient(creds.apiKey);
      const qs = this.signedParams({}, creds.apiSecret);
      const { data } = await client.get(`/api/v3/account?${qs}`);
      return (data.balances as any[])
        .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
        .map((b) => ({
          asset: b.asset,
          free: parseFloat(b.free),
          locked: parseFloat(b.locked),
        }));
    } catch (err) {
      this.throwMexcError(err);
    }
  }

  async getTicker() {
    const { data } = await axios.get(
      `${BASE_URL}/api/v3/ticker/24hr?symbol=${SYMBOL}`,
    );
    return {
      symbol: data.symbol,
      price: parseFloat(data.lastPrice),
      priceChange: parseFloat(data.priceChange),
      priceChangePercent: parseFloat(data.priceChangePercent),
      high: parseFloat(data.highPrice),
      low: parseFloat(data.lowPrice),
      volume: parseFloat(data.volume),
      quoteVolume: parseFloat(data.quoteVolume),
    };
  }

  async getOrderBook(limit = 20) {
    const { data } = await axios.get(
      `${BASE_URL}/api/v3/depth?symbol=${SYMBOL}&limit=${limit}`,
    );
    return {
      bids: (data.bids as string[][]).map(([price, qty]) => ({
        price: parseFloat(price),
        qty: parseFloat(qty),
      })),
      asks: (data.asks as string[][]).map(([price, qty]) => ({
        price: parseFloat(price),
        qty: parseFloat(qty),
      })),
    };
  }

  async getRecentTrades(limit = 20) {
    const { data } = await axios.get(
      `${BASE_URL}/api/v3/trades?symbol=${SYMBOL}&limit=${limit}`,
    );
    return (data as any[]).map((t) => ({
      id: t.id,
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      time: t.time,
      isBuyerMaker: t.isBuyerMaker,
    }));
  }

  async getOrderHistory(creds: MexcCredentials, limit = 50) {
    try {
      const client = this.buildClient(creds.apiKey);
      const qs = this.signedParams({ symbol: SYMBOL, limit }, creds.apiSecret);
      const { data } = await client.get(`/api/v3/allOrders?${qs}`);
      // Return filled and cancelled orders only, newest first
      return (data as any[])
        .filter((o) => o.status === 'FILLED' || o.status === 'CANCELED' || o.status === 'PARTIALLY_FILLED')
        .sort((a, b) => b.updateTime - a.updateTime)
        .slice(0, 30);
    } catch (err) {
      this.throwMexcError(err);
    }
  }

  async getOpenOrders(creds: MexcCredentials) {
    try {
      const client = this.buildClient(creds.apiKey);
      const qs = this.signedParams({ symbol: SYMBOL }, creds.apiSecret);
      const { data } = await client.get(`/api/v3/openOrders?${qs}`);
      return data;
    } catch (err) {
      this.throwMexcError(err);
    }
  }

  async placeOrder(
    userId: string,
    creds: MexcCredentials,
    side: 'BUY' | 'SELL',
    type: 'MARKET' | 'LIMIT',
    quantity: string,
    price?: string,
    quoteOrderQty?: string,
    idempotencyKey?: string,
  ) {
    this.safety.ensureEnabled();
    if (type === 'LIMIT' && !price) {
      throw new BadRequestException('Price required for LIMIT orders');
    }

    const { baseIncrement, quoteIncrement } = await this.precision.get('mexc', INTERNAL_SYMBOL);
    const clientOrderId = generateClientOid('mexc', idempotencyKey);
    const existing = await this.prisma.order.findUnique({ where: { userId_exchange_clientOrderId: { userId, exchange: 'mexc', clientOrderId } } });
    if (existing) return { orderId: existing.exchangeOrderId, clientOrderId, status: existing.status, idempotent: true };

    const client = this.buildClient(creds.apiKey);
    const params: Record<string, any> = { symbol: SYMBOL, side, type, newClientOrderId: clientOrderId };

    if (quoteOrderQty && side === 'BUY' && type === 'MARKET') {
      params.quoteOrderQty = this.precision.round(quoteOrderQty, quoteIncrement);
    } else {
      params.quantity = this.precision.round(quantity, baseIncrement);
    }

    if (type === 'LIMIT') {
      params.price = this.precision.round(price!, quoteIncrement);
      params.timeInForce = 'GTC';
    }

    const safety = await this.safety.validate({
      userId, side, type, quantity: params.quantity ?? '0', price: params.price,
      quoteOrderQty: params.quoteOrderQty, precision: await this.precision.get('mexc', INTERNAL_SYMBOL),
      book: await this.getOrderBook(100), balances: await this.getBalances(creds),
    });
    // A concurrent request with the same client order ID loses the unique-index race here
    // and must return the winner's order instead of sending a second one.
    let order: { id: string };
    try {
      order = await this.prisma.order.create({ data: {
      userId, exchange: 'mexc', symbol: SYMBOL, side, type,
      quantity: params.quantity ?? '0', price: params.price, status: 'NEW',
      clientOrderId, notionalUsdt: safety.notional,
    } });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      const dup = await this.prisma.order.findUnique({ where: { userId_exchange_clientOrderId: { userId, exchange: 'mexc', clientOrderId } } });
      if (!dup) throw err;
      return { orderId: dup.exchangeOrderId, clientOrderId, status: dup.status, idempotent: true };
    }

    const log = await this.execLog.startOrder({
      userId, exchange: 'mexc', symbol: INTERNAL_SYMBOL,
      side, type, quantity: params.quantity, price: params.price,
      quoteQty: params.quoteOrderQty, clientOrderId,
    });

    const t0 = Date.now();
    try {
      const qs = this.signedParams(params, creds.apiSecret);
      const { data } = await client.post(`/api/v3/order?${qs}`, {});
      await log.resolve(data.orderId ?? '', Date.now() - t0);
      await this.prisma.order.update({ where: { id: order.id }, data: { exchangeOrderId: String(data.orderId ?? ''), status: data.status ?? 'NEW' } });
      return data;
    } catch (err) {
      await log.reject(isAxiosError(err) ? (err.response?.data?.msg ?? err.message) : String(err), Date.now() - t0);
      if (isAxiosError(err) && (!err.response || err.code === 'ECONNABORTED')) {
        try {
          const qs = this.signedParams({ symbol: SYMBOL, origClientOrderId: clientOrderId }, creds.apiSecret);
          const { data } = await client.get(`/api/v3/order?${qs}`);
          await this.prisma.order.update({ where: { id: order.id }, data: { exchangeOrderId: String(data.orderId ?? ''), status: data.status ?? 'NEW' } });
          return data;
        } catch { /* a failed lookup is safe: do not submit again */ }
      }
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'REJECTED' } });
      this.throwMexcError(err);
    }
  }

  async cancelAll(userId: string, creds: MexcCredentials) {
    const client = this.buildClient(creds.apiKey);
    const qs = this.signedParams({ symbol: SYMBOL }, creds.apiSecret);
    const { data } = await client.delete(`/api/v3/openOrders?${qs}`);
    await this.prisma.order.updateMany({ where: { userId, exchange: 'mexc', status: { in: ['NEW', 'PARTIALLY_FILLED'] } }, data: { status: 'CANCELED' } });
    return data;
  }

  async cancelOrder(userId: string, creds: MexcCredentials, orderId: string) {
    const owned = await this.prisma.order.findFirst({ where: { userId, exchange: 'mexc', exchangeOrderId: orderId } });
    if (!owned) throw new NotFoundException('Order not found');
    try {
      const client = this.buildClient(creds.apiKey);
      const qs = this.signedParams({ symbol: SYMBOL, orderId }, creds.apiSecret);
      const { data } = await client.delete(`/api/v3/order?${qs}`);
      await this.prisma.order.update({ where: { id: owned.id }, data: { status: 'CANCELED' } });
      return data;
    } catch (err) {
      this.throwMexcError(err);
    }
  }

  async getOrderStatus(creds: MexcCredentials, orderId: string) {
    try {
      const client = this.buildClient(creds.apiKey);
      const qs = this.signedParams({ symbol: SYMBOL, orderId }, creds.apiSecret);
      const { data } = await client.get(`/api/v3/order?${qs}`);
      return data;
    } catch (err) {
      this.throwMexcError(err);
    }
  }
}
