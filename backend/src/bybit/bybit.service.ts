import { Injectable, BadRequestException, BadGatewayException, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import { PrecisionEngine } from '../exchange/precision.engine';
import { ExecutionLogService } from '../execution-log/execution-log.service';
import { generateClientOid } from '../exchange/client-oid.util';
import { INTERNAL_SYMBOL } from '../exchange/types';
import { TradingSafetyService } from '../exchange/trading-safety.service';
import { PrismaService } from '../prisma/prisma.service';

const BASE_URL = 'https://api.bybit.com';
const SYMBOL = 'ZIGUSDT';
const CATEGORY = 'spot';
const RECV_WINDOW = '10000';

export interface BybitCredentials {
  apiKey: string;
  apiSecret: string;
}

@Injectable()
export class BybitService {
  private readonly logger = new Logger(BybitService.name);

  constructor(
    private precision: PrecisionEngine,
    private execLog: ExecutionLogService,
    private safety: TradingSafetyService,
    private prisma: PrismaService,
  ) {}

  // ── Auth ────────────────────────────────────────────────────────────────

  private sign(payload: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  /** Headers for signed GET requests (query string is pre-built, no '?'). */
  private authHeaders(queryString: string, creds: BybitCredentials): Record<string, string> {
    const ts = Date.now().toString();
    const sig = this.sign(`${ts}${creds.apiKey}${RECV_WINDOW}${queryString}`, creds.apiSecret);
    return {
      'X-BAPI-API-KEY': creds.apiKey,
      'X-BAPI-SIGN': sig,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    };
  }

  /** Headers for signed POST requests (body is JSON-stringified object). */
  private authHeadersPost(body: object, creds: BybitCredentials): Record<string, string> {
    const ts = Date.now().toString();
    const bodyStr = JSON.stringify(body);
    const sig = this.sign(`${ts}${creds.apiKey}${RECV_WINDOW}${bodyStr}`, creds.apiSecret);
    return {
      'X-BAPI-API-KEY': creds.apiKey,
      'X-BAPI-SIGN': sig,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'Content-Type': 'application/json',
    };
  }

  private client(): AxiosInstance {
    return axios.create({ baseURL: BASE_URL, timeout: 10_000 });
  }

  /** Bybit always returns HTTP 200; errors live in retCode/retMsg. */
  private unwrap<T>(data: any, context: string): T {
    if (data.retCode !== 0) {
      this.logger.error(`[${context}] Bybit error ${data.retCode}: ${data.retMsg}`);
      throw new BadGatewayException({ message: data.retMsg, bybitCode: data.retCode });
    }
    return data.result as T;
  }

  private throwError(err: unknown, context: string): never {
    if (isAxiosError(err)) {
      const msg = err.response?.data?.retMsg ?? err.message;
      const code = err.response?.data?.retCode;
      this.logger.error(`[${context}] HTTP error: ${msg} (code=${code})`);
      throw new BadGatewayException({ message: msg, bybitCode: code });
    }
    throw err;
  }

  // ── Public market data ──────────────────────────────────────────────────

  async getTicker() {
    try {
      const { data } = await this.client().get(
        `/v5/market/tickers?category=${CATEGORY}&symbol=${SYMBOL}`,
      );
      const r = this.unwrap<{ list: any[] }>(data, 'getTicker');
      const t = r.list[0];
      return {
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        priceChange: parseFloat(t.lastPrice) - parseFloat(t.prevPrice24h),
        priceChangePercent: parseFloat(t.price24hPcnt) * 100,
        high: parseFloat(t.highPrice24h),
        low: parseFloat(t.lowPrice24h),
        volume: parseFloat(t.volume24h),
        quoteVolume: parseFloat(t.turnover24h),
      };
    } catch (err) {
      this.throwError(err, 'getTicker');
    }
  }

  async getOrderBook(limit = 20) {
    try {
      const { data } = await this.client().get(
        `/v5/market/orderbook?category=${CATEGORY}&symbol=${SYMBOL}&limit=${limit}`,
      );
      const r = this.unwrap<{ b: string[][]; a: string[][] }>(data, 'getOrderBook');
      return {
        bids: r.b.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
        asks: r.a.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
      };
    } catch (err) {
      this.throwError(err, 'getOrderBook');
    }
  }

  async getRecentTrades(limit = 20) {
    try {
      const { data } = await this.client().get(
        `/v5/market/recent-trade?category=${CATEGORY}&symbol=${SYMBOL}&limit=${limit}`,
      );
      const r = this.unwrap<{ list: any[] }>(data, 'getRecentTrades');
      return r.list.map((t) => ({
        id: t.execId,
        price: parseFloat(t.price),
        qty: parseFloat(t.size),
        time: parseInt(t.time, 10),
        isBuyerMaker: t.side === 'Sell', // Sell = price taker is seller = buyer is maker
      }));
    } catch (err) {
      this.throwError(err, 'getRecentTrades');
    }
  }

  // ── Authenticated ───────────────────────────────────────────────────────

  async validateCredentials(creds: BybitCredentials): Promise<boolean> {
    try {
      const qs = `accountType=UNIFIED`;
      const { data } = await this.client().get(
        `/v5/account/wallet-balance?${qs}`,
        { headers: this.authHeaders(qs, creds) },
      );
      return data.retCode === 0;
    } catch (err) {
      this.logger.warn(`Bybit credential validation failed: ${err}`);
      return false;
    }
  }

  async getBalances(creds: BybitCredentials) {
    try {
      const balanceMap = new Map<string, { free: number; locked: number }>();
      const tradingCoins = new Set<string>(); // coins already found in trading account

      const safeNum = (v: any) => { const n = parseFloat(v ?? '0'); return isNaN(n) ? 0 : n; };

      // ── Trading accounts — check UNIFIED and SPOT, keep the larger amount per coin ──
      // Bybit UTA stores spot in UNIFIED; classic accounts use SPOT.
      // We query both and take the max so we never miss the real balance.
      for (const accountType of ['UNIFIED', 'SPOT']) {
        const qs = `accountType=${accountType}`;
        const { data } = await this.client().get(
          `/v5/account/wallet-balance?${qs}`,
          { headers: this.authHeaders(qs, creds) },
        );
        if (data.retCode !== 0) continue;
        const coins: any[] = data.result?.list?.[0]?.coin ?? [];
        this.logger.debug(`[getBalances] ${accountType}: ${coins.length} coins — ${coins.map((c: any) => `${c.coin}:${c.walletBalance}`).join(', ')}`);
        for (const c of coins) {
          // Use equity (total) over walletBalance — in UTA, walletBalance can reflect
          // only the collateral portion while equity = full spot quantity.
          const wallet = Math.max(safeNum(c.equity), safeNum(c.walletBalance));
          if (wallet <= 0) continue;
          const orderLocked = safeNum(c.totalOrderIM) + safeNum(c.totalPositionIM);
          const locked = Math.min(wallet, orderLocked);
          const free = Math.max(0, wallet - locked);
          // Keep the larger balance if the coin appears in both account types
          const existing = balanceMap.get(c.coin);
          if (!existing || wallet > (existing.free + existing.locked)) {
            balanceMap.set(c.coin, { free, locked });
            tradingCoins.add(c.coin);
          }
        }
      }

      // ── Funding wallet (deposits land here before transfer to trading) ──
      // Only include coins not already present in the trading account to avoid double-counting.
      try {
        const qs = `accountType=FUND`;
        const { data } = await this.client().get(
          `/v5/asset/transfer/query-account-coins-balance?${qs}`,
          { headers: this.authHeaders(qs, creds) },
        );
        if (data.retCode === 0) {
          const assets: any[] = data.result?.balance ?? [];
          this.logger.debug(`[getBalances] FUND: ${assets.map((c: any) => `${c.coin}:${c.walletBalance}`).join(', ')}`);
          for (const c of assets) {
            const wallet = safeNum(c.walletBalance);
            if (wallet <= 0) continue;
            // Keep the larger value — FUND may have the correct spot amount
            const existing = balanceMap.get(c.coin);
            if (!existing || wallet > (existing.free + existing.locked)) {
              balanceMap.set(c.coin, { free: wallet, locked: 0 });
            }
          }
        }
      } catch {
        // Funding wallet query is best-effort — ignore errors
      }

      return Array.from(balanceMap.entries())
        .map(([asset, { free, locked }]) => ({ asset, free, locked }));
    } catch (err) {
      this.throwError(err, 'getBalances');
    }
  }

  /** Normalize Bybit order fields to a MEXC-compatible shape for the frontend. */
  private normalizeOrder(o: any) {
    const statusMap: Record<string, string> = {
      New: 'NEW',
      PartiallyFilled: 'PARTIALLY_FILLED',
      Filled: 'FILLED',
      Cancelled: 'CANCELED',
      PartiallyFilledCanceled: 'CANCELED',
      Rejected: 'CANCELED',
    };
    return {
      orderId: o.orderId,
      symbol: o.symbol,
      side: (o.side as string).toUpperCase(),
      type: (o.orderType as string).toUpperCase(),
      origQty: o.qty,
      price: o.price,
      executedQty: o.cumExecQty ?? '0',
      cummulativeQuoteQty: o.cumExecValue ?? '0',
      status: statusMap[o.orderStatus] ?? o.orderStatus,
      time: parseInt(o.createdTime ?? '0', 10),
      updateTime: parseInt(o.updatedTime ?? '0', 10),
    };
  }

  async getOpenOrders(creds: BybitCredentials) {
    try {
      const qs = `category=${CATEGORY}&symbol=${SYMBOL}`;
      const { data } = await this.client().get(
        `/v5/order/realtime?${qs}`,
        { headers: this.authHeaders(qs, creds) },
      );
      const r = this.unwrap<{ list: any[] }>(data, 'getOpenOrders');
      return r.list.map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOpenOrders');
    }
  }

  async getOrderHistory(creds: BybitCredentials, limit = 30) {
    try {
      const qs = `category=${CATEGORY}&symbol=${SYMBOL}&limit=${limit}`;
      const { data } = await this.client().get(
        `/v5/order/history?${qs}`,
        { headers: this.authHeaders(qs, creds) },
      );
      const r = this.unwrap<{ list: any[] }>(data, 'getOrderHistory');
      return r.list
        .filter((o) => ['Filled', 'Cancelled', 'PartiallyFilledCanceled'].includes(o.orderStatus))
        .map((o) => this.normalizeOrder(o));
    } catch (err) {
      this.throwError(err, 'getOrderHistory');
    }
  }

  async placeOrder(
    userId: string,
    creds: BybitCredentials,
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

    const { baseIncrement, quoteIncrement } = await this.precision.get('bybit', INTERNAL_SYMBOL);
    const clientOrderId = generateClientOid('bybit', idempotencyKey);
    const existing = await this.prisma.order.findUnique({ where: { userId_exchange_clientOrderId: { userId, exchange: 'bybit', clientOrderId } } });
    if (existing) return { orderId: existing.exchangeOrderId, orderLinkId: clientOrderId, status: existing.status, idempotent: true };

    const bybitSide = side === 'BUY' ? 'Buy' : 'Sell';
    const bybitType = type === 'LIMIT' ? 'Limit' : 'Market';

    const body: Record<string, any> = {
      category: CATEGORY,
      symbol: SYMBOL,
      side: bybitSide,
      orderType: bybitType,
      orderLinkId: clientOrderId,
    };

    if (type === 'MARKET' && side === 'BUY' && quoteOrderQty) {
      body.qty = this.precision.round(quoteOrderQty, quoteIncrement);
      body.marketUnit = 'quoteCoin';
    } else {
      body.qty = this.precision.round(quantity, baseIncrement);
    }

    if (type === 'LIMIT') {
      body.price = this.precision.round(price!, quoteIncrement);
      body.timeInForce = 'GTC';
    }

    const safety = await this.safety.validate({
      userId, side, type, quantity: type === 'MARKET' && side === 'BUY' ? '0' : body.qty,
      price: body.price, quoteOrderQty: type === 'MARKET' && side === 'BUY' ? body.qty : undefined,
      precision: await this.precision.get('bybit', INTERNAL_SYMBOL),
      book: await this.getOrderBook(100), balances: await this.getBalances(creds),
    });
    // A concurrent request with the same client order ID loses the unique-index race here
    // and must return the winner's order instead of sending a second one.
    let order: { id: string };
    try {
      order = await this.prisma.order.create({ data: {
      userId, exchange: 'bybit', symbol: SYMBOL, side, type,
      quantity: type === 'MARKET' && side === 'BUY' ? '0' : body.qty,
      price: body.price, status: 'NEW', clientOrderId, notionalUsdt: safety.notional,
    } });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      const dup = await this.prisma.order.findUnique({ where: { userId_exchange_clientOrderId: { userId, exchange: 'bybit', clientOrderId } } });
      if (!dup) throw err;
      return { orderId: dup.exchangeOrderId, orderLinkId: clientOrderId, status: dup.status, idempotent: true };
    }

    const log = await this.execLog.startOrder({
      userId, exchange: 'bybit', symbol: INTERNAL_SYMBOL,
      side, type, quantity: body.qty, price: body.price,
      quoteQty: type === 'MARKET' && side === 'BUY' && quoteOrderQty ? body.qty : undefined,
      clientOrderId,
    });

    const t0 = Date.now();
    try {
      const { data } = await this.client().post('/v5/order/create', body, {
        headers: this.authHeadersPost(body, creds),
      });
      const result = this.unwrap<any>(data, 'placeOrder');
      await log.resolve(result?.orderId ?? '', Date.now() - t0);
      await this.prisma.order.update({ where: { id: order.id }, data: { exchangeOrderId: result?.orderId ?? '', status: 'NEW' } });
      return result;
    } catch (err) {
      await log.reject(isAxiosError(err) ? (err.response?.data?.retMsg ?? err.message) : String(err), Date.now() - t0);
      if (isAxiosError(err) && (!err.response || err.code === 'ECONNABORTED')) {
        try {
          const qs = `category=${CATEGORY}&symbol=${SYMBOL}&orderLinkId=${clientOrderId}`;
          const { data } = await this.client().get(`/v5/order/realtime?${qs}`, { headers: this.authHeaders(qs, creds) });
          const found = this.unwrap<{ list: any[] }>(data, 'idempotencyLookup').list[0];
          if (found) {
            await this.prisma.order.update({ where: { id: order.id }, data: { exchangeOrderId: found.orderId, status: found.orderStatus ?? 'NEW' } });
            return found;
          }
        } catch { /* never resend after an ambiguous timeout */ }
      }
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'REJECTED' } });
      this.throwError(err, 'placeOrder');
    }
  }

  async cancelAll(userId: string, creds: BybitCredentials) {
    const body = { category: CATEGORY, symbol: SYMBOL };
    const { data } = await this.client().post('/v5/order/cancel-all', body, { headers: this.authHeadersPost(body, creds) });
    const result = this.unwrap(data, 'cancelAll');
    await this.prisma.order.updateMany({ where: { userId, exchange: 'bybit', status: { in: ['NEW', 'PARTIALLY_FILLED'] } }, data: { status: 'CANCELED' } });
    return result;
  }

  async cancelOrder(userId: string, creds: BybitCredentials, orderId: string) {
    const owned = await this.prisma.order.findFirst({ where: { userId, exchange: 'bybit', exchangeOrderId: orderId } });
    if (!owned) throw new NotFoundException('Order not found');
    const body = { category: CATEGORY, symbol: SYMBOL, orderId };
    try {
      const { data } = await this.client().post('/v5/order/cancel', body, {
        headers: this.authHeadersPost(body, creds),
      });
      const result = this.unwrap(data, 'cancelOrder');
      await this.prisma.order.update({ where: { id: owned.id }, data: { status: 'CANCELED' } });
      return result;
    } catch (err) {
      this.throwError(err, 'cancelOrder');
    }
  }

  async getOrderStatus(creds: BybitCredentials, orderId: string) {
    try {
      const qs = `category=${CATEGORY}&symbol=${SYMBOL}&orderId=${orderId}`;
      const { data } = await this.client().get(
        `/v5/order/realtime?${qs}`,
        { headers: this.authHeaders(qs, creds) },
      );
      const r = this.unwrap<{ list: any[] }>(data, 'getOrderStatus');
      return r.list[0] ?? null;
    } catch (err) {
      this.throwError(err, 'getOrderStatus');
    }
  }
}
