import Decimal from 'decimal.js';
import { CycleRecord, LiveOrder, RungRecord } from '../rung-accounting';
import { Fill } from '../types';

export interface Genesis {
  baseAtStart: Decimal;
  quoteAtStart: Decimal;
  createdAt: number;
}

export interface Commit {
  fills: Fill[];
  rungs: RungRecord[];
  cycle?: CycleRecord;
}

/**
 * The engine's only memory. Every method that changes rung state for a fill is atomic: a fill and
 * the rung transition it causes are written in one transaction or not at all.
 */
export interface Ledger {
  getGenesis(pairId: string): Promise<Genesis | null>;
  setGenesis(pairId: string, genesis: Genesis): Promise<void>;
  loadRungs(pairId: string): Promise<RungRecord[]>;
  /** Non-fill changes: intent recorded before sending, order live, cancel in flight. */
  saveRungs(pairId: string, rungs: RungRecord[]): Promise<void>;
  hasFill(pairId: string, fillId: string): Promise<boolean>;
  /** Returns false (and writes nothing) if any fill was already recorded. */
  commit(pairId: string, change: Commit): Promise<boolean>;
  listFills(pairId: string): Promise<Fill[]>;
  listCycles(pairId: string): Promise<CycleRecord[]>;
  addSweep(pairId: string, amount: Decimal, approvers: string[]): Promise<void>;
  sumSweeps(pairId: string): Promise<Decimal>;
  audit(pairId: string | null, kind: string, detail: Record<string, unknown>, actor?: string): Promise<void>;
  isKilled(pairId: string): Promise<boolean>;
  /** Latest heartbeat for dashboards: status, reason and a snapshot of the engine. */
  saveStatus(pairId: string, status: string, reason: string | undefined, snapshot: unknown): Promise<void>;
  setKilled(pairId: string, killed: boolean, by: string): Promise<void>;
}

// ── (De)serialisation: Decimals travel as strings so nothing is ever rounded by JSON ──────────────

const RUNG_DECIMALS = [
  'sellPrice', 'buyPrice', 'legQty', 'legFilled', 'soldQty', 'soldQuote', 'feeSellQuote', 'boughtGross',
  'boughtNet', 'buyCost', 'feeBuyQuote', 'feeBuyBase',
] as const;
const ORDER_DECIMALS = ['price', 'qty', 'filled', 'ackedFilled'] as const;
const FILL_DECIMALS = ['price', 'qty', 'feeAmount'] as const;
const CYCLE_DECIMALS = [
  'soldQty', 'avgSell', 'soldQuote', 'boughtGross', 'boughtNet', 'avgBuy', 'buyCost', 'feeSellQuote',
  'feeBuyQuote', 'feeBuyBase', 'profit',
] as const;

function convert(obj: any, fields: readonly string[], to: (v: any) => any): any {
  const out = { ...obj };
  for (const f of fields) if (out[f] !== undefined && out[f] !== null) out[f] = to(out[f]);
  return out;
}
const toStr = (v: Decimal) => v.toFixed();
const toDec = (v: string) => new Decimal(v);

export function serializeRung(r: RungRecord): any {
  const o = convert(r, RUNG_DECIMALS, toStr);
  o.order = r.order ? convert(r.order, ORDER_DECIMALS, toStr) : null;
  return o;
}
export function deserializeRung(o: any): RungRecord {
  const r = convert(o, RUNG_DECIMALS, toDec);
  r.order = o.order ? (convert(o.order, ORDER_DECIMALS, toDec) as LiveOrder) : null;
  return r as RungRecord;
}
export const serializeFill = (f: Fill) => convert(f, FILL_DECIMALS, toStr);
export const deserializeFill = (o: any): Fill => convert(o, FILL_DECIMALS, toDec) as Fill;
export const serializeCycle = (c: CycleRecord) => convert(c, CYCLE_DECIMALS, toStr);
export const deserializeCycle = (o: any): CycleRecord => convert(o, CYCLE_DECIMALS, toDec) as CycleRecord;
