import Decimal from 'decimal.js';
import { Pool, PoolClient } from 'pg';
import { Fill } from '../engine/types';
import {
  SeriesCommit, SeriesStore, deserializeCycle, deserializeFill, deserializeSlot, serializeCycle, serializeFill, serializeSlot,
} from './store';
import { Slot, SeriesCycle, SeriesRun, SeriesSettings } from './types';

type Mode = 'paper' | 'backtest' | 'live';

const toRun = (r: any): SeriesRun => ({
  id: r.id, ownerId: r.owner_id, mode: r.mode, seriesNo: r.series_no, settings: r.settings as SeriesSettings,
  basePrice: new Decimal(r.base_price), qty: new Decimal(r.qty), startZig: new Decimal(r.start_zig), startUsdt: new Decimal(r.start_usdt),
  status: r.status, statusReason: r.status_reason, startedAt: new Date(r.started_at).getTime(),
  stoppedAt: r.stopped_at ? new Date(r.stopped_at).getTime() : null,
  lastResetAt: r.last_reset_at ? new Date(r.last_reset_at).getTime() : null,
  resets: Number(r.resets ?? 0),
  carriedBase: new Decimal(r.carried_base ?? 0),
  carriedQuote: new Decimal(r.carried_quote ?? 0),
});

/** Postgres store using plain SQL (see backend/sql/004_series.sql). */
export class PgSeriesStore implements SeriesStore {
  constructor(private readonly pool: Pool) {}

  async createRun(r: Omit<SeriesRun, 'id' | 'seriesNo' | 'status' | 'statusReason' | 'stoppedAt'>): Promise<SeriesRun> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise per user and mode so two starts cannot take the same series number.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`series:${r.ownerId}:${r.mode}`]);
      const next = await client.query('SELECT COALESCE(MAX(series_no), 0) + 1 AS n FROM series_runs WHERE owner_id=$1 AND mode=$2', [r.ownerId, r.mode]);
      const { rows } = await client.query(
        `INSERT INTO series_runs (owner_id, mode, series_no, settings, base_price, qty, start_zig, start_usdt, status, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING', to_timestamp($9/1000.0)) RETURNING *`,
        [r.ownerId, r.mode, next.rows[0].n, r.settings, r.basePrice.toFixed(), r.qty.toFixed(), r.startZig.toFixed(), r.startUsdt.toFixed(), r.startedAt],
      );
      await client.query('COMMIT');
      return toRun(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async stopRun(runId: string, reason: string) {
    await this.pool.query(`UPDATE series_runs SET status='STOPPED', status_reason=$2, stopped_at=now() WHERE id=$1 AND status='RUNNING'`, [runId, reason]);
  }

  async recordReset(runId: string, x: { basePrice: Decimal; qty: Decimal; at: number; carriedBase: Decimal; carriedQuote: Decimal }) {
    await this.pool.query(
      `UPDATE series_runs SET base_price=$2, qty=$3, last_reset_at=to_timestamp($4/1000.0), resets=resets+1, carried_base=$5, carried_quote=$6
       WHERE id=$1`,
      [runId, x.basePrice.toFixed(), x.qty.toFixed(), x.at, x.carriedBase.toFixed(), x.carriedQuote.toFixed()],
    );
  }

  async getRun(runId: string) {
    const { rows } = await this.pool.query('SELECT * FROM series_runs WHERE id=$1', [runId]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async latestRun(ownerId: string, mode: Mode) { return (await this.listRuns(ownerId, mode, 1))[0] ?? null; }

  async listRuns(ownerId: string, mode: Mode, limit: number) {
    const { rows } = await this.pool.query('SELECT * FROM series_runs WHERE owner_id=$1 AND mode=$2 ORDER BY series_no DESC LIMIT $3', [ownerId, mode, limit]);
    return rows.map(toRun);
  }

  async stopOrphans(mode: Mode, reason: string) {
    const { rowCount } = await this.pool.query(`UPDATE series_runs SET status='STOPPED', status_reason=$2, stopped_at=now() WHERE mode=$1 AND status='RUNNING'`, [mode, reason]);
    return rowCount ?? 0;
  }

  private async upsertSlots(db: Pool | PoolClient, runId: string, slots: Slot[]) {
    for (const s of slots) {
      await db.query(
        `INSERT INTO series_slots (run_id, slot, data) VALUES ($1,$2,$3)
         ON CONFLICT (run_id, slot) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [runId, s.slot, serializeSlot(s)],
      );
    }
  }

  async saveSlots(runId: string, slots: Slot[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.upsertSlots(client, runId, slots);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async loadSlots(runId: string): Promise<Slot[]> {
    const { rows } = await this.pool.query('SELECT data FROM series_slots WHERE run_id=$1 ORDER BY slot', [runId]);
    return rows.map((r) => deserializeSlot(r.data));
  }

  async hasFill(runId: string, fillId: string) {
    const { rowCount } = await this.pool.query('SELECT 1 FROM series_fills WHERE run_id=$1 AND fill_id=$2', [runId, fillId]);
    return (rowCount ?? 0) > 0;
  }

  async commit(runId: string, c: SeriesCommit): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const f of c.fills) {
        const res = await client.query(
          `INSERT INTO series_fills (run_id, fill_id, ts, data) VALUES ($1,$2,$3,$4) ON CONFLICT (run_id, fill_id) DO NOTHING`,
          [runId, f.fillId, f.ts, serializeFill(f)],
        );
        if (res.rowCount === 0) { await client.query('ROLLBACK'); return false; }
      }
      await this.upsertSlots(client, runId, c.slots);
      if (c.cycle) {
        await client.query(
          'INSERT INTO series_cycles (run_id, slot, cycle, closed_at, data) VALUES ($1,$2,$3,to_timestamp($4/1000.0),$5)',
          [runId, c.cycle.slot, c.cycle.cycle, c.cycle.closedAt, serializeCycle(c.cycle)],
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

  async listFills(runId: string): Promise<Fill[]> {
    const { rows } = await this.pool.query('SELECT data FROM series_fills WHERE run_id=$1 ORDER BY seq', [runId]);
    return rows.map((r) => deserializeFill(r.data));
  }

  async listCycles(runId: string): Promise<SeriesCycle[]> {
    const { rows } = await this.pool.query('SELECT data FROM series_cycles WHERE run_id=$1 ORDER BY id', [runId]);
    return rows.map((r) => deserializeCycle(r.data));
  }

  async event(runId: string, kind: string, detail: Record<string, unknown>) {
    await this.pool.query('INSERT INTO series_events (run_id, kind, detail) VALUES ($1,$2,$3)', [runId, kind, detail]);
  }

  async listEvents(runId: string, limit: number) {
    const { rows } = await this.pool.query('SELECT ts, kind, detail FROM series_events WHERE run_id=$1 ORDER BY id DESC LIMIT $2', [runId, limit]);
    return rows.map((r) => ({ ts: new Date(r.ts).getTime(), kind: r.kind as string, detail: r.detail as Record<string, unknown> }));
  }

  async saveStatus(runId: string, status: string, reason: string | undefined, snapshot: unknown) {
    await this.pool.query(
      `INSERT INTO series_status (run_id, status, reason, snapshot, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (run_id) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason, snapshot=EXCLUDED.snapshot, updated_at=now()`,
      [runId, status, reason ?? null, JSON.stringify(snapshot)],
    );
  }

  /** Newest fills first, for the dashboard. */
  async recentFills(runId: string, limit: number): Promise<Fill[]> {
    const { rows } = await this.pool.query('SELECT data FROM series_fills WHERE run_id=$1 ORDER BY seq DESC LIMIT $2', [runId, limit]);
    return rows.map((r) => deserializeFill(r.data));
  }

  async countFills(runId: string) {
    const { rows } = await this.pool.query(
      `SELECT count(*) FILTER (WHERE data->>'side'='SELL') AS sells, count(*) FILTER (WHERE data->>'side'='BUY') AS buys FROM series_fills WHERE run_id=$1`, [runId],
    );
    return { sells: Number(rows[0].sells), buys: Number(rows[0].buys) };
  }

  /** A user's series with their loop count and booked profit, newest first. */
  async runSummaries(ownerId: string, mode: Mode, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT r.*, COALESCE(c.n, 0) AS cycles, COALESCE(c.profit, 0) AS profit
       FROM series_runs r
       LEFT JOIN (SELECT run_id, count(*) AS n, sum((data->>'profit')::numeric) AS profit FROM series_cycles GROUP BY run_id) c ON c.run_id = r.id
       WHERE r.owner_id=$1 AND r.mode=$2 ORDER BY r.series_no DESC LIMIT $3`,
      [ownerId, mode, limit],
    );
    return rows.map((r) => ({ run: toRun(r), cycles: Number(r.cycles), profit: new Decimal(r.profit) }));
  }

  /** Every series of this mode still marked as running (to resume after a restart). */
  async runningRuns(mode: Mode): Promise<SeriesRun[]> {
    const { rows } = await this.pool.query(`SELECT * FROM series_runs WHERE mode=$1 AND status='RUNNING' ORDER BY started_at`, [mode]);
    return rows.map(toRun);
  }

  async getStatus(runId: string) {
    const { rows } = await this.pool.query('SELECT status, reason, snapshot, updated_at FROM series_status WHERE run_id=$1', [runId]);
    return rows[0] ? { status: rows[0].status, reason: rows[0].reason, snapshot: rows[0].snapshot, updatedAt: new Date(rows[0].updated_at).getTime() } : null;
  }
}
