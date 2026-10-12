import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { CycleRecord, RungRecord } from '../rung-accounting';
import { Fill } from '../types';
import {
  Commit, Genesis, Ledger, deserializeCycle, deserializeFill, deserializeRung, serializeCycle, serializeFill, serializeRung,
} from './ledger';

/** Postgres ledger using plain SQL (see backend/sql). */
export class PgLedger implements Ledger {
  constructor(private readonly pool: Pool) {}

  async getGenesis(pairId: string): Promise<Genesis | null> {
    const { rows } = await this.pool.query('SELECT data FROM engine_genesis WHERE pair_id=$1', [pairId]);
    if (!rows[0]) return null;
    const d = rows[0].data;
    return { baseAtStart: new Decimal(d.baseAtStart), quoteAtStart: new Decimal(d.quoteAtStart), createdAt: d.createdAt };
  }

  async setGenesis(pairId: string, g: Genesis): Promise<void> {
    await this.pool.query(
      `INSERT INTO engine_genesis (pair_id, data) VALUES ($1,$2)
       ON CONFLICT (pair_id) DO NOTHING`,
      [pairId, { baseAtStart: g.baseAtStart.toFixed(), quoteAtStart: g.quoteAtStart.toFixed(), createdAt: g.createdAt }],
    );
  }

  async loadRungs(pairId: string): Promise<RungRecord[]> {
    const { rows } = await this.pool.query('SELECT data FROM engine_rungs WHERE pair_id=$1 ORDER BY rung_key', [pairId]);
    return rows.map((r) => deserializeRung(r.data));
  }

  private async upsertRungs(db: Pool | PoolClient, pairId: string, rungs: RungRecord[]) {
    for (const r of rungs) {
      await db.query(
        `INSERT INTO engine_rungs (pair_id, rung_key, data) VALUES ($1,$2,$3)
         ON CONFLICT (pair_id, rung_key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [pairId, r.key, serializeRung(r)],
      );
    }
  }

  async saveRungs(pairId: string, rungs: RungRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.upsertRungs(client, pairId, rungs);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async hasFill(pairId: string, fillId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM engine_fills WHERE pair_id=$1 AND fill_id=$2', [pairId, fillId]);
    return (rowCount ?? 0) > 0;
  }

  async commit(pairId: string, change: Commit): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const f of change.fills) {
        const res = await client.query(
          `INSERT INTO engine_fills (pair_id, fill_id, ts, data) VALUES ($1,$2,$3,$4)
           ON CONFLICT (pair_id, fill_id) DO NOTHING`,
          [pairId, f.fillId, f.ts, serializeFill(f)],
        );
        if (res.rowCount === 0) { await client.query('ROLLBACK'); return false; }
      }
      await this.upsertRungs(client, pairId, change.rungs);
      if (change.cycle) {
        await client.query(
          `INSERT INTO engine_cycles (pair_id, rung_key, cycle, data) VALUES ($1,$2,$3,$4)`,
          [pairId, change.cycle.rungKey, change.cycle.cycle, serializeCycle(change.cycle)],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async listFills(pairId: string): Promise<Fill[]> {
    const { rows } = await this.pool.query('SELECT data FROM engine_fills WHERE pair_id=$1 ORDER BY seq', [pairId]);
    return rows.map((r) => deserializeFill(r.data));
  }

  async listCycles(pairId: string): Promise<CycleRecord[]> {
    const { rows } = await this.pool.query('SELECT data FROM engine_cycles WHERE pair_id=$1 ORDER BY id', [pairId]);
    return rows.map((r) => deserializeCycle(r.data));
  }

  async addSweep(pairId: string, amount: Decimal, approvers: string[]): Promise<void> {
    await this.pool.query('INSERT INTO engine_sweeps (pair_id, amount, approvers) VALUES ($1,$2,$3)', [pairId, amount.toFixed(), approvers.join(',')]);
  }

  async sumSweeps(pairId: string): Promise<Decimal> {
    const { rows } = await this.pool.query('SELECT amount FROM engine_sweeps WHERE pair_id=$1', [pairId]);
    return rows.reduce((sum, r) => sum.plus(r.amount), new Decimal(0));
  }

  async audit(pairId: string | null, kind: string, detail: Record<string, unknown>, actor?: string): Promise<void> {
    await this.pool.query('INSERT INTO engine_audit (pair_id, kind, actor, detail) VALUES ($1,$2,$3,$4)', [pairId, kind, actor ?? null, detail]);
  }

  async saveStatus(pairId: string, status: string, reason: string | undefined, snapshot: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO engine_status (pair_id, status, reason, snapshot, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (pair_id) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason, snapshot=EXCLUDED.snapshot, updated_at=now()`,
      [pairId, status, reason ?? null, JSON.stringify(snapshot)],
    );
  }

  async isKilled(pairId: string): Promise<boolean> {
    // A user's "all pairs" switch is `<ownerId>/*`; it never reaches another user's pairs.
    const owner = pairId.includes('/') ? pairId.slice(0, pairId.indexOf('/')) : null;
    const ids = owner ? [pairId, `${owner}/*`] : [pairId];
    const { rows } = await this.pool.query('SELECT killed FROM engine_control WHERE pair_id = ANY($1)', [ids]);
    return rows.some((r) => r.killed === true);
  }

  async setKilled(pairId: string, killed: boolean, by: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO engine_control (pair_id, killed, requested_by) VALUES ($1,$2,$3)
       ON CONFLICT (pair_id) DO UPDATE SET killed=EXCLUDED.killed, requested_by=EXCLUDED.requested_by, updated_at=now()`,
      [pairId, killed, by],
    );
  }
}
