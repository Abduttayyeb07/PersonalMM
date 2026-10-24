import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { Fill } from '../engine/types';
import { cloneSlot } from './accounting';
import { SeriesCommit, SeriesStore } from './store';
import { Slot, SeriesCycle, SeriesRun } from './types';

/** In-memory store for backtests and tests. Same contract as the Postgres store. */
export class MemorySeriesStore implements SeriesStore {
  private runs = new Map<string, SeriesRun>();
  private slots = new Map<string, Map<number, Slot>>();
  private fills = new Map<string, Fill[]>();
  private fillIds = new Map<string, Set<string>>();
  private cycles = new Map<string, SeriesCycle[]>();
  private events = new Map<string, Array<{ ts: number; kind: string; detail: Record<string, unknown> }>>();
  private statuses = new Map<string, { status: string; reason: string | null; snapshot: any; updatedAt: number }>();
  /** Test hook: make the next commit throw, to prove a crash leaves no half-written state. */
  failNextCommit = false;
  now: () => number = () => Date.now();

  async createRun(r: Omit<SeriesRun, 'id' | 'seriesNo' | 'status' | 'statusReason' | 'stoppedAt'>) {
    const seriesNo = Math.max(0, ...[...this.runs.values()].filter((x) => x.ownerId === r.ownerId && x.mode === r.mode).map((x) => x.seriesNo)) + 1;
    const run: SeriesRun = { ...r, id: randomUUID(), seriesNo, status: 'RUNNING', statusReason: null, stoppedAt: null };
    this.runs.set(run.id, run);
    return run;
  }

  async stopRun(runId: string, reason: string) {
    const r = this.runs.get(runId);
    if (r && r.status === 'RUNNING') { r.status = 'STOPPED'; r.statusReason = reason; r.stoppedAt = this.now(); }
  }

  async recordReset(runId: string, x: { basePrice: Decimal; qty: Decimal; at: number; carriedBase: Decimal; carriedQuote: Decimal }) {
    const r = this.runs.get(runId);
    if (!r) return;
    r.basePrice = x.basePrice;
    r.qty = x.qty;
    r.lastResetAt = x.at;
    r.resets = (r.resets ?? 0) + 1;
    r.carriedBase = x.carriedBase;
    r.carriedQuote = x.carriedQuote;
  }

  async getRun(runId: string) { return this.runs.get(runId) ?? null; }
  async latestRun(ownerId: string, mode: 'paper' | 'backtest' | 'live') {
    return (await this.listRuns(ownerId, mode, 1))[0] ?? null;
  }
  async listRuns(ownerId: string, mode: 'paper' | 'backtest' | 'live', limit: number) {
    return [...this.runs.values()].filter((r) => r.ownerId === ownerId && r.mode === mode).sort((a, b) => b.seriesNo - a.seriesNo).slice(0, limit);
  }
  async stopOrphans(mode: 'paper' | 'backtest' | 'live', reason: string) {
    let n = 0;
    for (const r of this.runs.values()) if (r.mode === mode && r.status === 'RUNNING') { r.status = 'STOPPED'; r.statusReason = reason; r.stoppedAt = this.now(); n++; }
    return n;
  }

  async saveSlots(runId: string, slots: Slot[]) {
    const m = this.slots.get(runId) ?? new Map<number, Slot>();
    for (const s of slots) m.set(s.slot, cloneSlot(s));
    this.slots.set(runId, m);
  }
  async loadSlots(runId: string) { return [...(this.slots.get(runId)?.values() ?? [])].map(cloneSlot).sort((a, b) => a.slot - b.slot); }
  async hasFill(runId: string, fillId: string) { return this.fillIds.get(runId)?.has(fillId) ?? false; }

  async commit(runId: string, c: SeriesCommit) {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('simulated crash during commit'); }
    const ids = this.fillIds.get(runId) ?? new Set<string>();
    if (c.fills.some((f) => ids.has(f.fillId))) return false;
    for (const f of c.fills) ids.add(f.fillId);
    this.fillIds.set(runId, ids);
    this.fills.set(runId, [...(this.fills.get(runId) ?? []), ...c.fills]);
    await this.saveSlots(runId, c.slots);
    if (c.cycle) this.cycles.set(runId, [...(this.cycles.get(runId) ?? []), c.cycle]);
    return true;
  }

  async listFills(runId: string) { return [...(this.fills.get(runId) ?? [])]; }
  async listCycles(runId: string) { return [...(this.cycles.get(runId) ?? [])]; }
  async event(runId: string, kind: string, detail: Record<string, unknown>) {
    this.events.set(runId, [{ ts: this.now(), kind, detail }, ...(this.events.get(runId) ?? [])]);
  }
  async listEvents(runId: string, limit: number) { return (this.events.get(runId) ?? []).slice(0, limit); }
  async saveStatus(runId: string, status: string, reason: string | undefined, snapshot: unknown) {
    this.statuses.set(runId, { status, reason: reason ?? null, snapshot, updatedAt: this.now() });
  }
  async getStatus(runId: string) { return this.statuses.get(runId) ?? null; }
}
