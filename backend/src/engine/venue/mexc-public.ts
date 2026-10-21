import axios from 'axios';
import Decimal from 'decimal.js';
import { Candle } from '../backtest/candles';
import { VenueSpecs } from '../types';

/** MEXC public market data (no API key): instrument rules, last price and 1-minute candles. */

const API = 'https://api.mexc.com/api/v3';

export async function mexcPublicSpecs(symbol: string): Promise<VenueSpecs> {
  const { data } = await axios.get(`${API}/exchangeInfo`, { params: { symbol }, timeout: 10_000 });
  const info = data?.symbols?.[0];
  if (!info || info.symbol !== symbol) throw new Error(`${symbol} is not listed on MEXC spot`);
  if (String(info.status) !== '1' || info.isSpotTradingAllowed === false) throw new Error(`${symbol} is not trading on MEXC spot right now`);
  return {
    // quotePrecision is the number of price decimals; baseAssetPrecision the number of quantity decimals.
    tick: new Decimal(1).div(new Decimal(10).pow(Number(info.quotePrecision))),
    lot: new Decimal(1).div(new Decimal(10).pow(Number(info.baseAssetPrecision))),
    minOrderValue: new Decimal(info.quoteAmountPrecision ?? '1'),
    makerFee: new Decimal(info.makerCommission ?? '0'),
    buyFeeAsset: 'base',
    maxOpenOrders: 500,
  };
}

export async function mexcLastPrice(symbol: string): Promise<Decimal> {
  const { data } = await axios.get(`${API}/ticker/price`, { params: { symbol }, timeout: 10_000 });
  if (!data?.price) throw new Error(`no MEXC price for ${symbol}`);
  return new Decimal(data.price);
}

/** Close of the 1-minute candle that ended at `endMs` (falls back to the last price). */
export async function mexcCloseAt(symbol: string, endMs: number): Promise<Decimal> {
  const { data } = await axios.get(`${API}/klines`, {
    params: { symbol, interval: '1m', startTime: endMs - 60_000, endTime: endMs - 1, limit: 1 },
    timeout: 10_000,
  });
  const close = Array.isArray(data) ? data[0]?.[4] : undefined;
  return close ? new Decimal(close) : mexcLastPrice(symbol);
}

/** 1-minute spot candles from MEXC, oldest first. */
export async function fetchMexcCandles(symbol: string, days: number, endMs = Date.now()): Promise<Candle[]> {
  const startMs = endMs - days * 86_400_000;
  const byStart = new Map<number, Candle>();
  for (let from = startMs, page = 0; from < endMs && page < 200; page++) {
    const { data } = await axios.get(`${API}/klines`, {
      params: { symbol, interval: '1m', startTime: from, endTime: Math.min(from + 500 * 60_000, endMs), limit: 500 },
      timeout: 15_000,
    });
    const rows: unknown[][] = Array.isArray(data) ? data : [];
    for (const [t, open, high, low, close, volume] of rows as string[][]) {
      byStart.set(Number(t), {
        start: Number(t), open: new Decimal(open), high: new Decimal(high), low: new Decimal(low), close: new Decimal(close), volume: new Decimal(volume),
      });
    }
    from += 500 * 60_000;
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}
