import axios from 'axios';
import Decimal from 'decimal.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface Candle {
  start: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  /** Base-asset volume. */
  volume: Decimal;
}

/** Fetches 1-minute spot candles from Bybit's public API (no key needed), oldest first. */
export async function fetchBybitCandles(symbol: string, days: number, endMs = Date.now()): Promise<Candle[]> {
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const byStart = new Map<number, Candle>();
  let cursorEnd = endMs;
  for (let page = 0; page < 200 && cursorEnd > startMs; page++) {
    const { data } = await axios.get('https://api.bybit.com/v5/market/kline', {
      params: { category: 'spot', symbol, interval: '1', start: startMs, end: cursorEnd, limit: 1000 },
      timeout: 15_000,
    });
    if (data?.retCode !== 0) throw new Error(`Bybit kline error ${data?.retCode}: ${data?.retMsg}`);
    const rows: string[][] = data.result?.list ?? [];
    if (!rows.length) break;
    for (const [start, open, high, low, close, volume] of rows) {
      const t = Number(start);
      if (t < startMs) continue;
      byStart.set(t, { start: t, open: new Decimal(open), high: new Decimal(high), low: new Decimal(low), close: new Decimal(close), volume: new Decimal(volume) });
    }
    const oldest = Math.min(...rows.map((r) => Number(r[0])));
    if (oldest >= cursorEnd) break;
    cursorEnd = oldest - 1;
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

export function saveCandles(path: string, candles: Candle[]) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = ['start,open,high,low,close,volume', ...candles.map((c) => [c.start, c.open, c.high, c.low, c.close, c.volume].join(','))];
  writeFileSync(path, lines.join('\n'));
}

export function loadCandles(path: string): Candle[] {
  return readFileSync(path, 'utf8').trim().split('\n').slice(1).map((line) => {
    const [start, open, high, low, close, volume] = line.split(',');
    return { start: Number(start), open: new Decimal(open), high: new Decimal(high), low: new Decimal(low), close: new Decimal(close), volume: new Decimal(volume) };
  });
}

/** Loads cached candles, fetching and caching them when missing. */
export async function candlesFor(symbol: string, days: number, cachePath: string, refresh = false): Promise<Candle[]> {
  if (!refresh && existsSync(cachePath)) return loadCandles(cachePath);
  const candles = await fetchBybitCandles(symbol, days);
  saveCandles(cachePath, candles);
  return candles;
}

/** Median base volume per hour over the candles (onboarding check). */
export function medianHourlyVolume(candles: Candle[]): Decimal {
  const hours = new Map<number, Decimal>();
  for (const c of candles) {
    const h = Math.floor(c.start / 3_600_000);
    hours.set(h, (hours.get(h) ?? new Decimal(0)).plus(c.volume));
  }
  const values = [...hours.values()].sort((a, b) => a.comparedTo(b));
  if (!values.length) return new Decimal(0);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : values[mid - 1].plus(values[mid]).div(2);
}
