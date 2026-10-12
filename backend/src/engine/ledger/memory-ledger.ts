import Decimal from 'decimal.js';
import { CycleRecord, RungRecord, cloneRung } from '../rung-accounting';
import { Fill } from '../types';
import { Commit, Genesis, Ledger } from './ledger';

/** In-memory ledger for the simulator, backtests and tests. Same contract as the Postgres ledger. */
export class MemoryLedger implements Ledger {
  private genesis = new Map<string, Genesis>();
  private rungs = new Map<string, Map<string, RungRecord>>();
  private fills = new Map<string, Fill[]>();
  private fillIds = new Map<string, Set<string>>();
  private cycles = new Map<string, CycleRecord[]>();
  private sweeps = new Map<string, Decimal>();
  private killed = new Map<string, boolean>();
  readonly auditLog: Array<{ pairId: string | null; kind: string; detail: Record<string, unknown>; actor?: string }> = [];
  /** Test hook: make the next commit throw, to prove a crash leaves no half-written state. */
  failNextCommit = false;

  async getGenesis(pairId: string) { return this.genesis.get(pairId) ?? null; }
  async setGenesis(pairId: string, g: Genesis) { this.genesis.set(pairId, g); }

  async loadRungs(pairId: string) {
    return [...(this.rungs.get(pairId)?.values() ?? [])].map(cloneRung);
  }

  async saveRungs(pairId: string, rungs: RungRecord[]) {
    const map = this.rungs.get(pairId) ?? new Map<string, RungRecord>();
    for (const r of rungs) map.set(r.key, cloneRung(r));
    this.rungs.set(pairId, map);
  }

  async hasFill(pairId: string, fillId: string) { return this.fillIds.get(pairId)?.has(fillId) ?? false; }

  async commit(pairId: string, change: Commit) {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('simulated crash during commit'); }
    const ids = this.fillIds.get(pairId) ?? new Set<string>();
    if (change.fills.some((f) => ids.has(f.fillId))) return false;
    for (const f of change.fills) ids.add(f.fillId);
    this.fillIds.set(pairId, ids);
    this.fills.set(pairId, [...(this.fills.get(pairId) ?? []), ...change.fills]);
    await this.saveRungs(pairId, change.rungs);
    if (change.cycle) this.cycles.set(pairId, [...(this.cycles.get(pairId) ?? []), change.cycle]);
    return true;
  }

  async listFills(pairId: string) { return [...(this.fills.get(pairId) ?? [])]; }
  async listCycles(pairId: string) { return [...(this.cycles.get(pairId) ?? [])]; }
  async addSweep(pairId: string, amount: Decimal) { this.sweeps.set(pairId, (this.sweeps.get(pairId) ?? new Decimal(0)).plus(amount)); }
  async sumSweeps(pairId: string) { return this.sweeps.get(pairId) ?? new Decimal(0); }
  async audit(pairId: string | null, kind: string, detail: Record<string, unknown>, actor?: string) {
    this.auditLog.push({ pairId, kind, detail, actor });
  }
  async isKilled(pairId: string) {
    const owner = pairId.includes('/') ? pairId.slice(0, pairId.indexOf('/')) : null;
    return this.killed.get(pairId) === true || (owner !== null && this.killed.get(`${owner}/*`) === true);
  }
  /** Copies one scope's rows into another ledger (used to publish a backtest to the dashboard). */
  async copyTo(target: Ledger, from: string, to: string): Promise<void> {
    const genesis = this.genesis.get(from);
    if (genesis) await target.setGenesis(to, genesis);
    const fills = this.fills.get(from) ?? [];
    const cycles = this.cycles.get(from) ?? [];
    // Commit fills in batches, then each cycle with its rung snapshot at the end.
    for (let i = 0; i < fills.length; i += 200) await target.commit(to, { fills: fills.slice(i, i + 200), rungs: [] });
    for (const c of cycles) await target.commit(to, { fills: [], rungs: [], cycle: c });
    await target.saveRungs(to, [...(this.rungs.get(from)?.values() ?? [])]);
    for (const e of this.auditLog.filter((x) => x.pairId === from).slice(-30)) await target.audit(to, e.kind, e.detail, e.actor);
  }

  readonly statuses = new Map<string, { status: string; reason?: string; snapshot: unknown }>();
  async saveStatus(pairId: string, status: string, reason: string | undefined, snapshot: unknown) {
    this.statuses.set(pairId, { status, reason, snapshot });
  }
  async setKilled(pairId: string, killed: boolean, _by?: string) { this.killed.set(pairId, killed); }
}
