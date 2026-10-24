import Decimal from 'decimal.js';
import { Fill } from '../engine/types';
import { Slot, SeriesCycle, SeriesRun } from './types';

export interface SeriesCommit {
  fills: Fill[];
  slots: Slot[];
  cycle?: SeriesCycle;
}

/** The series engine's only memory. A fill and the slot change it causes are written atomically. */
export interface SeriesStore {
  createRun(run: Omit<SeriesRun, 'id' | 'seriesNo' | 'status' | 'statusReason' | 'stoppedAt'>): Promise<SeriesRun>;
  stopRun(runId: string, reason: string): Promise<void>;
  /** Saves a daily reset: the new base and size, when it happened, and what open loops left behind. */
  recordReset(runId: string, r: { basePrice: Decimal; qty: Decimal; at: number; carriedBase: Decimal; carriedQuote: Decimal }): Promise<void>;
  getRun(runId: string): Promise<SeriesRun | null>;
  /** Latest run for a user and mode, or null. */
  latestRun(ownerId: string, mode: 'paper' | 'backtest' | 'live'): Promise<SeriesRun | null>;
  listRuns(ownerId: string, mode: 'paper' | 'backtest' | 'live', limit: number): Promise<SeriesRun[]>;
  /** Marks every RUNNING run of this mode as stopped (the process that owned it is gone). */
  stopOrphans(mode: 'paper' | 'backtest' | 'live', reason: string): Promise<number>;
  saveSlots(runId: string, slots: Slot[]): Promise<void>;
  loadSlots(runId: string): Promise<Slot[]>;
  hasFill(runId: string, fillId: string): Promise<boolean>;
  /** Returns false (and writes nothing) if any fill was already recorded. */
  commit(runId: string, change: SeriesCommit): Promise<boolean>;
  listFills(runId: string): Promise<Fill[]>;
  listCycles(runId: string): Promise<SeriesCycle[]>;
  event(runId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  listEvents(runId: string, limit: number): Promise<Array<{ ts: number; kind: string; detail: Record<string, unknown> }>>;
  saveStatus(runId: string, status: string, reason: string | undefined, snapshot: unknown): Promise<void>;
  getStatus(runId: string): Promise<{ status: string; reason: string | null; snapshot: any; updatedAt: number } | null>;
}

// ── (De)serialisation: Decimals travel as strings so nothing is ever rounded by JSON ──────────

const SLOT_DECIMALS = [
  'qty', 'sellTarget', 'buyTarget', 'legQty', 'legFilled', 'soldQty', 'soldQuote', 'feeSellQuote',
  'boughtGross', 'boughtNet', 'buyCost', 'feeBuyQuote',
] as const;
const ORDER_DECIMALS = ['price', 'qty', 'filled', 'ackedFilled'] as const;
const FILL_DECIMALS = ['price', 'qty', 'feeAmount'] as const;
const CYCLE_DECIMALS = ['soldQty', 'avgSell', 'avgBuy', 'soldQuote', 'boughtGross', 'boughtNet', 'buyCost', 'feeSellQuote', 'feeBuyQuote', 'profit'] as const;

function convert(obj: any, fields: readonly string[], to: (v: any) => any): any {
  const out = { ...obj };
  for (const f of fields) if (out[f] !== undefined && out[f] !== null) out[f] = to(out[f]);
  return out;
}
const toStr = (v: Decimal) => v.toFixed();
const toDec = (v: string) => new Decimal(v);

export function serializeSlot(s: Slot): any {
  const o = convert(s, SLOT_DECIMALS, toStr);
  o.order = s.order ? convert(s.order, ORDER_DECIMALS, toStr) : null;
  return o;
}
export function deserializeSlot(o: any): Slot {
  const s = convert(o, SLOT_DECIMALS, toDec);
  s.order = o.order ? convert(o.order, ORDER_DECIMALS, toDec) : null;
  return s as Slot;
}
export const serializeFill = (f: Fill) => convert(f, FILL_DECIMALS, toStr);
export const deserializeFill = (o: any): Fill => convert(o, FILL_DECIMALS, toDec) as Fill;
export const serializeCycle = (c: SeriesCycle) => convert(c, CYCLE_DECIMALS, toStr);
export const deserializeCycle = (o: any): SeriesCycle => convert(o, CYCLE_DECIMALS, toDec) as SeriesCycle;
