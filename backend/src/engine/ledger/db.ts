import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export function createPool(url = process.env.DATABASE_URL): Pool {
  if (!url) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: url, max: 5 });
}

/**
 * Minimal forward-only migration runner for the engine's plain SQL files in backend/sql.
 * Each file runs once, in its own transaction, and is recorded in engine_schema_migrations.
 */
export async function migrate(pool: Pool, dir = process.env.ENGINE_SQL_DIR ?? join(process.cwd(), 'sql')): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS engine_schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query('SELECT name FROM engine_schema_migrations')).rows.map((r) => r.name as string));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO engine_schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}
