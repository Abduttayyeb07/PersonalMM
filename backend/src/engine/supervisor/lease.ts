import { Pool } from 'pg';
import { Clock } from '../types';

/**
 * One writer per pair. A lease has a TTL and a monotonically increasing epoch (the fencing token).
 * Every order carries the epoch it was issued under, and the risk gate rejects stale ones.
 */
export interface Lease {
  /** Returns the new epoch, or null if another holder still has a live lease. */
  acquire(pairId: string, holder: string, ttlMs: number): Promise<number | null>;
  /** True if we still hold this exact epoch and it has not expired. Extends the TTL when true. */
  renew(pairId: string, holder: string, epoch: number, ttlMs: number): Promise<boolean>;
  /** True if `epoch` is still the current, unexpired epoch held by `holder`. Does not extend. */
  verify(pairId: string, holder: string, epoch: number): Promise<boolean>;
  release(pairId: string, holder: string, epoch: number): Promise<void>;
}

export class MemoryLease implements Lease {
  private rows = new Map<string, { holder: string; epoch: number; expiresAt: number }>();
  constructor(private readonly clock: Clock) {}

  async acquire(pairId: string, holder: string, ttlMs: number) {
    const row = this.rows.get(pairId);
    if (row && row.expiresAt > this.clock.now() && row.holder !== holder) return null;
    const epoch = (row?.epoch ?? 0) + 1;
    this.rows.set(pairId, { holder, epoch, expiresAt: this.clock.now() + ttlMs });
    return epoch;
  }

  async renew(pairId: string, holder: string, epoch: number, ttlMs: number) {
    const row = this.rows.get(pairId);
    if (!row || row.holder !== holder || row.epoch !== epoch || row.expiresAt <= this.clock.now()) return false;
    row.expiresAt = this.clock.now() + ttlMs;
    return true;
  }

  async verify(pairId: string, holder: string, epoch: number) {
    const row = this.rows.get(pairId);
    return !!row && row.holder === holder && row.epoch === epoch && row.expiresAt > this.clock.now();
  }

  async release(pairId: string, holder: string, epoch: number) {
    const row = this.rows.get(pairId);
    if (row && row.holder === holder && row.epoch === epoch) row.expiresAt = 0;
  }
}

/** Postgres lease. The database clock decides expiry, so host clock drift cannot create two writers. */
export class PgLease implements Lease {
  constructor(private readonly pool: Pool) {}

  async acquire(pairId: string, holder: string, ttlMs: number) {
    const { rows } = await this.pool.query(
      `INSERT INTO engine_leases (pair_id, holder, epoch, expires_at)
       VALUES ($1, $2, 1, now() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (pair_id) DO UPDATE
         SET holder = EXCLUDED.holder,
             epoch = engine_leases.epoch + 1,
             expires_at = now() + ($3 || ' milliseconds')::interval
         WHERE engine_leases.expires_at < now() OR engine_leases.holder = EXCLUDED.holder
       RETURNING epoch`,
      [pairId, holder, String(ttlMs)],
    );
    return rows[0] ? Number(rows[0].epoch) : null;
  }

  async renew(pairId: string, holder: string, epoch: number, ttlMs: number) {
    const { rowCount } = await this.pool.query(
      `UPDATE engine_leases SET expires_at = now() + ($4 || ' milliseconds')::interval
       WHERE pair_id=$1 AND holder=$2 AND epoch=$3 AND expires_at > now()`,
      [pairId, holder, epoch, String(ttlMs)],
    );
    return (rowCount ?? 0) > 0;
  }

  async verify(pairId: string, holder: string, epoch: number) {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM engine_leases WHERE pair_id=$1 AND holder=$2 AND epoch=$3 AND expires_at > now()',
      [pairId, holder, epoch],
    );
    return (rowCount ?? 0) > 0;
  }

  async release(pairId: string, holder: string, epoch: number) {
    await this.pool.query(
      `UPDATE engine_leases SET expires_at = now() - interval '1 second' WHERE pair_id=$1 AND holder=$2 AND epoch=$3`,
      [pairId, holder, epoch],
    );
  }
}
