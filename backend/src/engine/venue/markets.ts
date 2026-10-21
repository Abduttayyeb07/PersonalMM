import Decimal from 'decimal.js';
import { existsSync } from 'fs';
import { Candle, fetchBybitCandles, loadCandles, saveCandles } from '../backtest/candles';
import { VenueSpecs } from '../types';
import { bybitCloseAt, bybitLastPrice, bybitPublicSpecs } from './bybit-public';
import { fetchMexcCandles, mexcCloseAt, mexcLastPrice, mexcPublicSpecs } from './mexc-public';

/** Exchanges whose public prices a simulation can follow. */
export type MarketVenue = 'BYBIT' | 'MEXC';
export const MARKET_VENUES: MarketVenue[] = ['BYBIT', 'MEXC'];

export function marketSpecs(venue: MarketVenue, symbol: string): Promise<VenueSpecs> {
  return venue === 'MEXC' ? mexcPublicSpecs(symbol) : bybitPublicSpecs(symbol);
}

export function marketLastPrice(venue: MarketVenue, symbol: string): Promise<Decimal> {
  return venue === 'MEXC' ? mexcLastPrice(symbol) : bybitLastPrice(symbol);
}

/** Close of the 1-minute candle that ended at `endMs`. */
export function marketCloseAt(venue: MarketVenue, symbol: string, endMs: number): Promise<Decimal> {
  return venue === 'MEXC' ? mexcCloseAt(symbol, endMs) : bybitCloseAt(symbol, endMs);
}

/** Cached 1-minute candles for backtests, fetched from the venue when missing. */
export async function marketCandles(venue: MarketVenue, symbol: string, days: number, cachePath: string, refresh = false): Promise<Candle[]> {
  if (!refresh && existsSync(cachePath)) return loadCandles(cachePath);
  const candles = venue === 'MEXC' ? await fetchMexcCandles(symbol, days) : await fetchBybitCandles(symbol, days);
  saveCandles(cachePath, candles);
  return candles;
}
