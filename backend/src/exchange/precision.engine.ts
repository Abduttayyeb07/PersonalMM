import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ExchangeName, SymbolPrecision } from './types';
import { toExchangeSymbol } from './symbol.util';
import Decimal from 'decimal.js';

@Injectable()
export class PrecisionEngine {
  private readonly logger = new Logger(PrecisionEngine.name);
  private readonly cache = new Map<string, SymbolPrecision>();

  async get(exchange: ExchangeName, internalSymbol: string): Promise<SymbolPrecision> {
    const key = `${exchange}:${internalSymbol}`;
    if (this.cache.has(key)) return this.cache.get(key)!;

    const precision = await this.fetch(exchange, internalSymbol);
    this.cache.set(key, precision);
    return precision;
  }

  // Round a quantity DOWN to the nearest valid increment
  round(value: string | number, increment: string): string {
    const step = new Decimal(increment);
    if (!step.isPositive()) return String(value);
    const decimals = (increment.includes('.') ? increment.split('.')[1] : '').length;
    return new Decimal(String(value)).div(step).floor().mul(step).toFixed(decimals);
  }

  private async fetch(exchange: ExchangeName, internalSymbol: string): Promise<SymbolPrecision> {
    const symbol = toExchangeSymbol(exchange, internalSymbol);
    try {
      switch (exchange) {
        case 'mexc':   return await this.fetchMexc(symbol);
        case 'bybit':  return await this.fetchBybit(symbol);
        case 'kucoin': return await this.fetchKucoin(symbol);
        case 'gateio': return await this.fetchGateio(symbol);
        case 'bitget': return await this.fetchBitget(symbol);
      }
    } catch (err) {
      this.logger.warn(`[${exchange}] Precision fetch failed for ${symbol}, using defaults: ${err}`);
    }
    return this.defaults(exchange, internalSymbol);
  }

  private async fetchMexc(symbol: string): Promise<SymbolPrecision> {
    const { data } = await axios.get(
      `https://api.mexc.com/api/v3/exchangeInfo?symbol=${symbol}`,
      { timeout: 8_000 },
    );
    const info = data.symbols?.[0];
    if (!info) throw new Error('Symbol not found');

    const lotFilter   = info.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
    const priceFilter = info.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
    const minNotional = info.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL');

    return {
      exchange: 'mexc',
      symbol: 'ZIG/USDT',
      baseIncrement:  lotFilter?.stepSize    ?? '1',
      quoteIncrement: priceFilter?.tickSize  ?? '0.00001',
      minBaseQty:     lotFilter?.minQty      ?? '1',
      minQuoteQty:    minNotional?.minNotional ?? '1',
    };
  }

  private async fetchBybit(symbol: string): Promise<SymbolPrecision> {
    const { data } = await axios.get(
      `https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=${symbol}`,
      { timeout: 8_000 },
    );
    const info = data.result?.list?.[0];
    if (!info) throw new Error('Symbol not found');

    const lot = info.lotSizeFilter ?? {};
    const price = info.priceFilter ?? {};

    return {
      exchange: 'bybit',
      symbol: 'ZIG/USDT',
      baseIncrement:  lot.basePrecision   ?? lot.qtyStep      ?? '1',
      quoteIncrement: price.tickSize                          ?? '0.00001',
      minBaseQty:     lot.minOrderQty                         ?? '1',
      minQuoteQty:    lot.minOrderAmt                         ?? '1',
    };
  }

  private async fetchKucoin(symbol: string): Promise<SymbolPrecision> {
    const { data } = await axios.get(
      `https://api.kucoin.com/api/v1/symbols/${symbol}`,
      { timeout: 8_000 },
    );
    if (data.code !== '200000') throw new Error(data.msg);
    const info = data.data;

    return {
      exchange: 'kucoin',
      symbol: 'ZIG/USDT',
      baseIncrement:  info.baseIncrement  ?? '1',
      quoteIncrement: info.quoteIncrement ?? '0.00001',
      minBaseQty:     info.baseMinSize    ?? '1',
      minQuoteQty:    info.quoteMinSize   ?? '0.1',
    };
  }

  private async fetchGateio(symbol: string): Promise<SymbolPrecision> {
    const { data } = await axios.get(
      `https://api.gateio.ws/api/v4/spot/currency_pairs/${symbol}`,
      { timeout: 8_000 },
    );
    // amount_precision = decimal places for base qty; precision = decimal places for price
    const precisionToIncrement = (p: number) =>
      p === 0 ? '1' : `0.${'0'.repeat(p - 1)}1`;

    return {
      exchange: 'gateio',
      symbol: 'ZIG/USDT',
      baseIncrement:  precisionToIncrement(data.amount_precision ?? 0),
      quoteIncrement: precisionToIncrement(data.precision       ?? 8),
      minBaseQty:     data.min_base_amount  ?? '1',
      minQuoteQty:    data.min_quote_amount ?? '1',
    };
  }

  private async fetchBitget(symbol: string): Promise<SymbolPrecision> {
    const { data } = await axios.get(
      `https://api.bitget.com/api/v2/spot/public/symbols?symbol=${symbol}`,
      { timeout: 8_000 },
    );
    if (data.code !== '00000') throw new Error(data.msg);
    const info = data.data?.[0];
    if (!info) throw new Error('Symbol not found');

    // quantityPrecision / pricePrecision are decimal-place counts
    const precisionToIncrement = (p: number) =>
      p === 0 ? '1' : `0.${'0'.repeat(p - 1)}1`;

    return {
      exchange: 'bitget',
      symbol: 'ZIG/USDT',
      baseIncrement:  precisionToIncrement(parseInt(info.quantityPrecision ?? '0', 10)),
      quoteIncrement: precisionToIncrement(parseInt(info.pricePrecision    ?? '6', 10)),
      minBaseQty:     info.minTradeAmount ?? '1',
      minQuoteQty:    info.minTradeUSDT  ?? '1',
    };
  }

  private defaults(exchange: ExchangeName, internalSymbol: string): SymbolPrecision {
    return {
      exchange,
      symbol: internalSymbol,
      baseIncrement:  '1',
      quoteIncrement: '0.00001',
      minBaseQty:     '1',
      minQuoteQty:    '1',
    };
  }
}
