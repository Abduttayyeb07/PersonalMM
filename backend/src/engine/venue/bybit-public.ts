import axios from 'axios';
import Decimal from 'decimal.js';
import { VenueSpecs } from '../types';

/** Bybit public market data (no API key): instrument rules and the last traded price. */

export async function bybitPublicSpecs(symbol: string): Promise<VenueSpecs> {
  const { data } = await axios.get('https://api.bybit.com/v5/market/instruments-info', { params: { category: 'spot', symbol }, timeout: 10_000 });
  const info = data?.result?.list?.[0];
  if (!info) throw new Error(`${symbol} is not listed on Bybit spot`);
  return {
    tick: new Decimal(info.priceFilter.tickSize),
    lot: new Decimal(info.lotSizeFilter.basePrecision),
    minOrderValue: new Decimal(info.lotSizeFilter.minOrderAmt),
    // The account fee tier needs a key; the spec's 0.10% maker fee is assumed here.
    makerFee: new Decimal('0.001'),
    buyFeeAsset: 'base',
    maxOpenOrders: 500,
  };
}

export async function bybitLastPrice(symbol: string): Promise<Decimal> {
  const { data } = await axios.get('https://api.bybit.com/v5/market/tickers', { params: { category: 'spot', symbol }, timeout: 10_000 });
  const last = data?.result?.list?.[0]?.lastPrice;
  if (!last) throw new Error(`no price for ${symbol}`);
  return new Decimal(last);
}
