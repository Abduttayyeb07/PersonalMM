import { ExchangeName } from './types';

// Internal canonical symbol → exchange-specific symbol
const SYMBOL_MAP: Record<ExchangeName, Record<string, string>> = {
  mexc:   { 'ZIG/USDT': 'ZIGUSDT' },
  bybit:  { 'ZIG/USDT': 'ZIGUSDT' },
  kucoin: { 'ZIG/USDT': 'ZIG-USDT' },
  gateio: { 'ZIG/USDT': 'ZIG_USDT' },
  bitget: { 'ZIG/USDT': 'ZIGUSDT' },
};

// Exchange-specific → internal canonical symbol
const REVERSE_MAP: Record<ExchangeName, Record<string, string>> = {
  mexc:   { 'ZIGUSDT':  'ZIG/USDT' },
  bybit:  { 'ZIGUSDT':  'ZIG/USDT' },
  kucoin: { 'ZIG-USDT': 'ZIG/USDT' },
  gateio: { 'ZIG_USDT': 'ZIG/USDT' },
  bitget: { 'ZIGUSDT':  'ZIG/USDT' },
};

export function toExchangeSymbol(exchange: ExchangeName, internal: string): string {
  return SYMBOL_MAP[exchange]?.[internal] ?? internal;
}

export function toInternalSymbol(exchange: ExchangeName, exSymbol: string): string {
  return REVERSE_MAP[exchange]?.[exSymbol] ?? exSymbol;
}
