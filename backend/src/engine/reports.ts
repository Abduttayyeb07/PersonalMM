import Decimal from 'decimal.js';
import { Pool } from 'pg';
import { Ledger } from './ledger/ledger';
import { reserveOf, baseResidual } from './invariants';
import { owed } from './rung-accounting';

const ZERO = new Decimal(0);

/** Monday 00:00 UTC on or before `t`. */
export function weekStart(t = Date.now()): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** The weekly report from the spec, built only from the ledger (plus audit rows for kill events). */
export async function weeklyReport(ledger: Ledger, pool: Pool | null, pairId: string, now = Date.now()) {
  const from = weekStart(now);
  const cycles = await ledger.listCycles(pairId);
  const rungs = await ledger.loadRungs(pairId);
  const sweeps = await ledger.sumSweeps(pairId);
  const genesis = await ledger.getGenesis(pairId);
  const week = cycles.filter((c) => c.closedAt >= from);
  const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), ZERO);
  const byRung: Record<string, number> = {};
  for (const c of week) byRung[c.rungKey] = (byRung[c.rungKey] ?? 0) + 1;
  const owedNow = sum(rungs.map(owed));
  let kills: Array<{ ts: string; reason: string }> = [];
  if (pool) {
    const { rows } = await pool.query(
      `SELECT ts, detail FROM engine_audit WHERE pair_id=$1 AND kind='KILL' AND ts >= to_timestamp($2/1000.0) ORDER BY ts`,
      [pairId, from],
    );
    kills = rows.map((r) => ({ ts: new Date(r.ts).toISOString(), reason: String(r.detail?.reason ?? '') }));
  }
  return {
    pairId,
    weekFrom: new Date(from).toISOString(),
    realisedProfitWeek: sum(week.map((c) => c.profit)).toFixed(2),
    realisedProfitCumulative: sum(cycles.map((c) => c.profit)).toFixed(2),
    sweptCumulative: sweeps.toFixed(2),
    unsweptProfit: sum(cycles.map((c) => c.profit)).minus(sweeps).toFixed(2),
    cyclesThisWeek: week.length,
    cyclesByRung: byRung,
    openCycles: {
      rungs: rungs.filter((r) => owed(r).gt(0)).length,
      baseAwaitingBuyback: owedNow.toFixed(),
      reserveBacking: reserveOf(rungs).toFixed(2),
    },
    baseHeldEstimate: genesis ? genesis.baseAtStart.minus(owedNow).plus(baseResidual(cycles)).toFixed() : null,
    baseAtStart: genesis?.baseAtStart.toFixed() ?? null,
    feesWeek: {
      makerQuote: sum(week.map((c) => c.feeSellQuote.plus(c.feeBuyQuote))).toFixed(4),
      makerBase: sum(week.map((c) => c.feeBuyBase)).toFixed(4),
      taker: '0 (every order is post-only)',
    },
    killSwitchEvents: kills,
  };
}
