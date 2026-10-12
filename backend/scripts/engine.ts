/* eslint-disable no-console */
import 'dotenv/config';
import Decimal from 'decimal.js';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { loadPairConfig, loadSharedConfig, configHash } from '../src/engine/config/engine-config';
import { candlesFor, medianHourlyVolume } from '../src/engine/backtest/candles';
import { runBacktest, formatReport } from '../src/engine/backtest/backtest';
import { BYBIT_ZIG_SPECS } from '../src/engine/testing';
import { runCommand } from '../src/engine/cli-commands';
import { createPool, migrate } from '../src/engine/ledger/db';
import { PgLedger } from '../src/engine/ledger/pg-ledger';
import { scopeId } from '../src/engine/engine-instance';

/**
 * Sell-first grid engine CLI.
 *   npm run engine -- backtest [--pair pairs/zigusdt-bybit.yaml] [--days 30] [--refresh]
 *   npm run engine -- <migrate|hash|onboard|init|run|status|kill|resume|report|sweep> ...
 */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function backtest() {
  const pairPath = arg('pair', 'pairs/zigusdt-bybit.yaml')!;
  const cfg = loadPairConfig(pairPath);
  const shared = loadSharedConfig(arg('shared', 'pairs/shared.yaml')!);
  const days = Number(arg('days', '30'));
  const cache = join('engine-data', `${cfg.symbol}-1m-${days}d.csv`);
  const candles = await candlesFor(cfg.symbol, days, cache, flag('refresh'));
  const specs = BYBIT_ZIG_SPECS;
  const startBase = cfg.maxBaseOwed;
  console.log(`Loaded ${candles.length} candles for ${cfg.symbol}; median hourly volume ${medianHourlyVolume(candles).toFixed(0)} ${cfg.baseAsset}`);

  const variants = [
    { label: 'live config', cfg },
    { label: 'step 2%', cfg: { ...cfg, step: new Decimal('0.02'), ladders: cfg.ladders.map((l, i) => ({ ...l, offset: new Decimal('0.01').mul(i) })) } },
  ];
  // --user <email>: publish the live-config run to that user's dashboard (Backtest view only).
  const email = arg('user');
  const publish = email ? async ({ ledger, scope, engine }: any) => {
    const pool = createPool();
    try {
      await migrate(pool);
      const user = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
      if (!user) throw new Error(`no user ${email}`);
      const target = scopeId(user.id, `${cfg.pairId}-BACKTEST`);
      for (const t of ['engine_rungs', 'engine_fills', 'engine_cycles', 'engine_genesis', 'engine_status']) {
        await pool.query(`DELETE FROM ${t} WHERE pair_id=$1`, [target]);
      }
      const pg = new PgLedger(pool);
      await ledger.copyTo(pg, scope, target);
      const snap = engine.snapshot();
      await pg.saveStatus(target, 'BACKTEST', `30-day replay ${candles[0] ? new Date(candles[0].start).toISOString().slice(0, 10) : ''} to ${new Date(candles[candles.length - 1].start).toISOString().slice(0, 10)}`, { ...snap, pairId: target });
      console.log(`published to ${email}'s dashboard (Backtest view)`);
    } finally {
      await pool.end();
    }
  } : undefined;

  const reports: Awaited<ReturnType<typeof runBacktest>>[] = [];
  for (const v of variants) {
    process.stdout.write(`Running ${v.label}... `);
    const r = await runBacktest({ label: v.label, cfg: v.cfg, shared, specs, candles, startBase, onFinish: v.label === 'live config' ? publish : undefined });
    console.log(`${r.cyclesCompleted} cycles, $${r.realisedProfitUsd}`);
    reports.push(r);
  }
  const text = formatReport(reports);
  console.log(`\n${text}`);
  mkdirSync('engine-data', { recursive: true });
  const out = join('engine-data', `backtest-${cfg.pairId}-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify({ hash: configHash(cfg), reports }, null, 2));
  console.log(`\nSaved ${out}`);
  const pass = reports[0].kills === 0 && reports[0].status === 'RUNNING' && new Decimal(reports[0].maxFormulaDeviationUsd).lt('0.01');
  console.log(pass ? 'PASS: no kill, no self-cross, every cycle matches the formula' : 'FAIL: see report');
  if (!pass) process.exitCode = 1;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'backtest') return backtest();
  return runCommand(cmd, arg, flag);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
