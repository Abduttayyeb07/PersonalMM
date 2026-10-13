import { Side } from '../engine/types';

export interface ParsedSeriesId {
  symbol: string;
  seriesNo: number;
  slot: number;
  cycle: number;
  side: Side;
  revision: number;
}

/** ZIGUSDT-S001-N07-C0003-B, or ...-B-r2 for a re-sent order. An ID is never reused (Bybit caps it at 36). */
export function buildSeriesOrderId(symbol: string, seriesNo: number, slot: number, cycle: number, side: Side, revision = 1): string {
  const base = `${symbol}-S${String(seriesNo).padStart(3, '0')}-N${String(slot).padStart(2, '0')}-C${String(cycle).padStart(4, '0')}-${side === 'SELL' ? 'S' : 'B'}`;
  return revision > 1 ? `${base}-r${revision}` : base;
}

const PATTERN = /^([A-Za-z0-9]+)-S(\d{3,})-N(\d{2,})-C(\d{4,})-([SB])(?:-r(\d+))?$/;

/** Returns null for any ID this engine did not issue. */
export function parseSeriesOrderId(id: string): ParsedSeriesId | null {
  const m = PATTERN.exec(id);
  if (!m) return null;
  return {
    symbol: m[1], seriesNo: Number(m[2]), slot: Number(m[3]), cycle: Number(m[4]),
    side: m[5] === 'S' ? 'SELL' : 'BUY', revision: m[6] ? Number(m[6]) : 1,
  };
}
