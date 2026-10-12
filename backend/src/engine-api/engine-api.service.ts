import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { loadPairConfig, loadSharedConfig, PairConfig, SharedConfig } from '../engine/config/engine-config';
import { buildSimConfig, SimSettings } from './simulation-config';
import { scopeId } from '../engine/engine-instance';
import { reserveOf, baseResidual } from '../engine/invariants';
import { migrate } from '../engine/ledger/db';
import { PgLedger } from '../engine/ledger/pg-ledger';
import { owed } from '../engine/rung-accounting';

export type EngineMode = 'paper' | 'live' | 'backtest';

const ZERO = new Decimal(0);
const DAY = 86_400_000;
const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), ZERO);

/** Plain-language status for the dashboard. */
export type DashboardStatus = 'RUNNING' | 'PAUSED' | 'KILLED' | 'STOPPED' | 'OFFLINE' | 'NOT_STARTED' | 'BACKTEST';

/**
 * Read model for the engine dashboard. Every query is scoped to `<userId>/<pairId>`; a user can only
 * ever see and control their own engine.
 */
@Injectable()
export class EngineApiService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineApiService.name);
  readonly pool: Pool;
  readonly ledger: PgLedger;
  private cfg: PairConfig | null = null;
  private shared: SharedConfig | null = null;

  constructor(config: ConfigService) {
    this.pool = new Pool({ connectionString: config.get<string>('DATABASE_URL'), max: 4 });
    this.ledger = new PgLedger(this.pool);
  }

  async onModuleInit() {
    await migrate(this.pool, process.env.ENGINE_SQL_DIR ?? join(process.cwd(), 'sql'));
    const path = process.env.ENGINE_PAIR_CONFIG ?? join(process.cwd(), 'pairs', 'zigusdt-bybit.yaml');
    if (existsSync(path)) this.cfg = loadPairConfig(path);
    const sharedPath = process.env.ENGINE_SHARED_CONFIG ?? join(process.cwd(), 'pairs', 'shared.yaml');
    if (existsSync(sharedPath)) this.shared = loadSharedConfig(sharedPath);
    else this.logger.warn(`engine pair config not found at ${path}`);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  baseConfig(): PairConfig {
    return this.config();
  }

  sharedConfig(): SharedConfig {
    if (!this.shared) throw new Error('engine shared config is not loaded');
    return this.shared;
  }

  private config(): PairConfig {
    if (!this.cfg) throw new Error('engine pair config is not loaded');
    return this.cfg;
  }

  scope(userId: string, mode: EngineMode): string {
    const cfg = this.config();
    const suffix = mode === 'paper' ? '-PAPER' : mode === 'backtest' ? '-BACKTEST' : '';
    return scopeId(userId, `${cfg.pairId}${suffix}`);
  }

  async overview(userId: string, mode: EngineMode, now = Date.now()) {
    const cfg = this.config();
    const scope = this.scope(userId, mode);
    const [rungs, cycles, sweeps, genesis, killed] = await Promise.all([
      this.ledger.loadRungs(scope), this.ledger.listCycles(scope), this.ledger.sumSweeps(scope),
      this.ledger.getGenesis(scope), this.ledger.isKilled(scope),
    ]);
    const statusRow = (await this.pool.query('SELECT status, reason, snapshot, updated_at FROM engine_status WHERE pair_id=$1', [scope])).rows[0];
    const leaseRow = (await this.pool.query('SELECT holder, epoch, expires_at FROM engine_leases WHERE pair_id=$1', [scope])).rows[0];
    const events = (await this.pool.query(
      'SELECT ts, kind, actor, detail FROM engine_audit WHERE pair_id=$1 ORDER BY id DESC LIMIT 30', [scope],
    )).rows;

    // Status: a heartbeat older than 30 s means the engine process is not running.
    const heartbeatAge = statusRow ? now - new Date(statusRow.updated_at).getTime() : null;
    let status: DashboardStatus;
    if (!genesis && !statusRow) status = 'NOT_STARTED';
    else if (mode === 'backtest') status = 'BACKTEST';
    else if (killed) status = 'KILLED';
    else if (statusRow?.status === 'STOPPED') status = 'STOPPED';
    else if (statusRow && heartbeatAge !== null && heartbeatAge < 30_000) status = statusRow.status as DashboardStatus;
    else status = 'OFFLINE';

    // Profit and cycles.
    const realised = sum(cycles.map((c) => c.profit));
    const since = (ms: number) => cycles.filter((c) => c.closedAt >= now - ms);
    const today = since(DAY);
    const week = since(7 * DAY);
    const durations = cycles.filter((c) => c.openedAt > 0).map((c) => c.closedAt - c.openedAt);
    const fees = sum(cycles.map((c) => c.feeSellQuote.plus(c.feeBuyQuote).plus(c.feeBuyBase.mul(c.avgBuy))));

    // Per-day series for the last 30 days (UTC), with the running total.
    const days = 30;
    const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
    const before = sum(cycles.filter((c) => c.closedAt < start).map((c) => c.profit));
    const series: Array<{ day: string; profit: string; cycles: number; cumulative: string }> = [];
    let running = before;
    for (let i = 0; i < days; i++) {
      const from = start + i * DAY;
      const inDay = cycles.filter((c) => c.closedAt >= from && c.closedAt < from + DAY);
      const p = sum(inDay.map((c) => c.profit));
      running = running.plus(p);
      series.push({ day: new Date(from).toISOString().slice(0, 10), profit: p.toFixed(2), cycles: inDay.length, cumulative: running.toFixed(2) });
    }

    // Per-rung: how many times each rung has cycled (= refilled) and what it earned.
    const perRung = new Map<string, { count: number; profit: Decimal }>();
    for (const c of cycles) {
      const e = perRung.get(c.rungKey) ?? { count: 0, profit: ZERO };
      perRung.set(c.rungKey, { count: e.count + 1, profit: e.profit.plus(c.profit) });
    }
    const baseOwed = sum(rungs.map(owed));
    const unswept = realised.minus(sweeps);
    const snapshot = statusRow?.snapshot ?? null;

    return {
      mode,
      pair: { id: cfg.pairId, symbol: cfg.symbol, base: cfg.baseAsset, quote: cfg.quoteAsset, venue: cfg.venue },
      status: {
        state: status,
        reason: killed ? 'Kill switch is set. Resume to restart the engine.' : statusRow?.reason ?? null,
        heartbeatAt: statusRow ? new Date(statusRow.updated_at).toISOString() : null,
        leaseHolder: leaseRow?.holder ?? null,
        lastInvariantCheck: snapshot?.lastInvariantCheck ?? null,
        breaches: snapshot?.lastBreaches ?? [],
      },
      market: snapshot?.book ?? null,
      config: await this.describeConfig(userId, mode, cfg),
      kpis: {
        realisedProfit: realised.toFixed(2),
        profitToday: sum(today.map((c) => c.profit)).toFixed(2),
        profit7d: sum(week.map((c) => c.profit)).toFixed(2),
        cyclesTotal: cycles.length,
        cyclesToday: today.length,
        cycles7d: week.length,
        refills: cycles.length,
        openCycles: rungs.filter((r) => owed(r).gt(0)).length,
        baseOwed: baseOwed.toFixed(),
        reserve: reserveOf(rungs).toFixed(2),
        unsweptProfit: unswept.toFixed(2),
        swept: sweeps.toFixed(2),
        avgProfitPerCycle: cycles.length ? realised.div(cycles.length).toFixed(2) : null,
        avgCycleMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60_000) : null,
        feesPaid: fees.toFixed(2),
        baseAtStart: genesis?.baseAtStart.toFixed() ?? null,
        quoteAtStart: genesis?.quoteAtStart.toFixed() ?? null,
        baseHeld: genesis ? genesis.baseAtStart.minus(baseOwed).plus(baseResidual(cycles)).toFixed() : null,
        liveOrders: rungs.filter((r) => r.order).length,
      },
      series,
      rungs: rungs
        .map((r) => ({
          key: r.key, ladder: r.ladder, n: r.n, state: r.state, cycle: r.cycle,
          sellPrice: r.sellPrice.toFixed(), buyPrice: r.buyPrice.toFixed(),
          owed: owed(r).toFixed(), refills: perRung.get(r.key)?.count ?? 0,
          profit: (perRung.get(r.key)?.profit ?? ZERO).toFixed(2),
          order: r.order ? { side: r.order.side, price: r.order.price.toFixed(), status: r.order.status } : null,
          waiting: r.waiting ?? null,
        }))
        .sort((a, b) => new Decimal(b.sellPrice).comparedTo(a.sellPrice)),
      recentCycles: cycles.slice(-40).reverse().map((c) => ({
        rung: c.rungKey, cycle: c.cycle, qty: c.soldQty.toFixed(), sellPrice: c.avgSell.toFixed(6), buyPrice: c.avgBuy.toFixed(6),
        profit: c.profit.toFixed(2), openedAt: c.openedAt ? new Date(c.openedAt).toISOString() : null,
        closedAt: new Date(c.closedAt).toISOString(), netted: c.netted,
      })),
      events: events.map((e) => ({ ts: new Date(e.ts).toISOString(), kind: e.kind, actor: e.actor, detail: e.detail })),
    };
  }

  /** The lattice the dashboard should describe: the user's simulation settings in paper mode. */
  private async describeConfig(userId: string, mode: EngineMode, fallback: PairConfig) {
    let cfg = fallback;
    if (mode === 'paper') {
      const row = (await this.pool.query('SELECT settings FROM engine_paper_settings WHERE owner_id=$1', [userId])).rows[0];
      const input = row?.settings?.input as SimSettings | undefined;
      const basePrice = row?.settings?.resolved?.basePrice as string | undefined;
      if (input && basePrice) {
        try {
          cfg = buildSimConfig(fallback, { ...input, basePrice }, new Decimal(basePrice), new Decimal(0));
        } catch { /* settings from an older version: fall back to the pair file */ }
      }
    }
    return {
      basePrice: cfg.basePrice.toFixed(), floorPrice: cfg.floorPrice.toFixed(), topPrice: cfg.topPrice.toFixed(),
      stepPct: cfg.step.mul(100).toFixed(), ladders: cfg.ladders.map((l) => l.name),
      rungSize: cfg.rungSizeBase.toFixed(), maxBaseOwed: cfg.maxBaseOwed.toFixed(),
    };
  }

  async kill(userId: string, mode: EngineMode, by: string) {
    const scope = this.scope(userId, mode);
    await this.ledger.setKilled(scope, true, by);
    await this.ledger.audit(scope, 'KILL_REQUESTED', { by, source: 'dashboard' }, by);
  }

  async resume(userId: string, mode: EngineMode, by: string) {
    const scope = this.scope(userId, mode);
    await this.ledger.setKilled(scope, false, by);
    await this.ledger.audit(scope, 'RESUME_REQUESTED', { by, source: 'dashboard' }, by);
  }
}
