import { createHash } from 'crypto';
import { Side } from './types';

export interface ParsedOrderId {
  symbol: string;
  rungKey: string;
  cycle: number;
  side: Side;
  revision: number;
}

/** ZIGUSDT-A+01-C0007-S, or ZIGUSDT-A+01-C0007-S-r2 for a re-quoted order. An ID is never reused. */
export function buildOrderId(symbol: string, rungKey: string, cycle: number, side: Side, revision = 1): string {
  const base = `${symbol}-${rungKey}-C${String(cycle).padStart(4, '0')}-${side === 'SELL' ? 'S' : 'B'}`;
  return revision > 1 ? `${base}-r${revision}` : base;
}

const PATTERN = /^([A-Za-z0-9]+)-([A-Za-z0-9]{1,4}[+-]\d{2,})-C(\d{4,})-([SB])(?:-r(\d+))?$/;

/** Returns null for any ID we did not issue. */
export function parseOrderId(id: string): ParsedOrderId | null {
  const m = PATTERN.exec(id);
  if (!m) return null;
  return {
    symbol: m[1],
    rungKey: m[2],
    cycle: Number(m[3]),
    side: m[4] === 'S' ? 'SELL' : 'BUY',
    revision: m[5] ? Number(m[5]) : 1,
  };
}

/** Venues cap client ID length (Bybit: 36). Long IDs are mapped to a short stable alias. */
export function shortAlias(id: string, maxLen: number): string {
  if (id.length <= maxLen) return id;
  return `Z${createHash('sha256').update(id).digest('hex').slice(0, maxLen - 1)}`;
}
