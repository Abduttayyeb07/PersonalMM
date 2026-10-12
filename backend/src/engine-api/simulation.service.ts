import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { PairConfig } from '../engine/config/engine-config';
import { auditRun } from '../engine/audit/spec-auditor';
import { owed, rebuildFromFills } from '../engine/rung-accounting';
import { VenueSpecs } from '../engine/types';
import Decimal from 'decimal.js';
import { hostname } from 'os';
import { buildLattice } from '../engine/lattice';
import { EngineInstance, scopeId } from '../engine/engine-instance';
import { PgLease } from '../engine/supervisor/lease';
import { PairRunner } from '../engine/supervisor/runner';
import { Alerter, Logger as EngineLogger, systemClock } from '../engine/types';
import { bybitLastPrice, bybitPublicSpecs } from '../engine/venue/bybit-public';
import { PaperVenue } from '../engine/venue/paper-venue';
import { EngineApiService } from './engine-api.service';
import { SimSettings, SimSettingsError, buildSimConfig, defaultSimSettings } from './simulation-config';

interface Run {
  runner: PairRunner;
  engine: EngineInstance;
  venue: PaperVenue;
  cfg: PairConfig;
  specs: VenueSpecs;
  startedAt: number;
  settings: SimSettings;
  watchdog: NodeJS.Timeout;
}

/**
 * Paper simulations started from the dashboard. Each user gets at most one, running the exact
 * engine code on live Bybit prices with simulated fills and balances. Nothing reaches an exchange.
 */
@Injectable()
export class SimulationService implements OnModuleDestroy {
  private readonly logger = new Logger(SimulationService.name);
  private readonly runs = new Map<string, Run>();
  /** The last finished run per user, kept so it can still be audited after it stops. */
  private readonly finished = new Map<string, Run>();
  private readonly starting = new Set<string>();

  constructor(private readonly api: EngineApiService) {}

  private engineLog(email: string): EngineLogger {
    return {
      info: (m) => this.logger.log(`[${email}] ${m}`),
      warn: (m) => this.logger.warn(`[${email}] ${m}`),
      error: (m) => this.logger.error(`[${email}] ${m}`),
    };
  }

  /** Paper runs do not page anyone; their events are in the audit log and the dashboard. */
  private quietAlerts(email: string): Alerter {
    return { send: async (t) => this.logger.log(`[${email}] ${t.replace(/\n/g, ' | ')}`) };
  }

  async status(userId: string) {
    const base = this.api.baseConfig();
    const row = (await this.api.pool.query(
      'SELECT settings, started_at, stopped_at, stop_reason FROM engine_paper_settings WHERE owner_id=$1', [userId],
    )).rows[0];
    const run = this.runs.get(userId);
    let market: string | null = null;
    try { market = (await bybitLastPrice(base.symbol)).toFixed(); } catch { /* market data optional here */ }
    return {
      running: !!run,
      startedAt: run ? new Date(run.startedAt).toISOString() : row?.started_at ?? null,
      stoppedAt: run ? null : row?.stopped_at ?? null,
      stopReason: run ? null : row?.stop_reason ?? null,
      settings: (row?.settings?.input as SimSettings | undefined) ?? defaultSimSettings(base),
      defaults: defaultSimSettings(base),
      marketPrice: market,
    };
  }

  /** Validates settings and reports what the lattice would look like, without starting anything. */
  async preview(settings: SimSettings) {
    const base = this.api.baseConfig();
    const [specs, market] = await Promise.all([bybitPublicSpecs(base.symbol), bybitLastPrice(base.symbol)]);
    let cfg;
    try {
      cfg = buildSimConfig(base, settings, market, specs.minOrderValue);
    } catch (e) {
      if (e instanceof SimSettingsError) throw new BadRequestException(e.message);
      throw e;
    }
    const lattice = buildLattice(cfg, specs);
    const above = lattice.filter((r) => r.sellPrice.gt(market));
    const fee = specs.makerFee;
    const sample = above[0] ?? lattice[lattice.length - 1];
    const profit = sample
      ? cfg.rungSizeBase.mul(sample.sellPrice).mul(new Decimal(1).minus(fee))
        .minus(cfg.rungSizeBase.div(new Decimal(1).minus(fee)).mul(sample.buyPrice))
      : new Decimal(0);
    return {
      rungs: lattice.length,
      rungsAboveMarket: above.length,
      zigNeededForAllSells: cfg.rungSizeBase.mul(lattice.length).toFixed(),
      zigArmedAtStart: Decimal.min(new Decimal(settings.startZig), cfg.rungSizeBase.mul(above.length)).toFixed(),
      basePrice: cfg.basePrice.toFixed(),
      marketPrice: market.toFixed(),
      profitPerCycle: profit.toFixed(2),
      lowestRung: lattice[0]?.sellPrice.toFixed() ?? null,
      highestRung: lattice[lattice.length - 1]?.sellPrice.toFixed() ?? null,
    };
  }

  async start(userId: string, email: string, settings: SimSettings) {
    if (this.runs.has(userId) || this.starting.has(userId)) throw new ConflictException('A simulation is already running. Stop it first.');
    this.starting.add(userId);
    try {
      const base = this.api.baseConfig();
      const [specs, market] = await Promise.all([bybitPublicSpecs(base.symbol), bybitLastPrice(base.symbol)]);
      let cfg;
      try {
        cfg = buildSimConfig(base, settings, market, specs.minOrderValue);
      } catch (e) {
        if (e instanceof SimSettingsError) throw new BadRequestException(e.message);
        throw e;
      }

      // Each start is a fresh run: clear only THIS user's paper rows (the audit log is kept).
      const scope = scopeId(userId, cfg.pairId);
      for (const table of ['engine_rungs', 'engine_fills', 'engine_cycles', 'engine_genesis', 'engine_control', 'engine_status']) {
        await this.api.pool.query(`DELETE FROM ${table} WHERE pair_id=$1`, [scope]);
      }

      const log = this.engineLog(email);
      const alert = this.quietAlerts(email);
      const venue = new PaperVenue({
        symbol: cfg.symbol, specs, clock: systemClock, log, startPrice: market,
        startBase: new Decimal(settings.startZig), startQuote: new Decimal(settings.startUsdt),
      });
      const engine = new EngineInstance({
        ownerId: userId, cfg, shared: this.api.sharedConfig(), specs, venue, ledger: this.api.ledger,
        lease: new PgLease(this.api.pool), alert, clock: systemClock, log,
        holder: `app:${hostname()}:${process.pid}`, mode: 'paper', approvedHash: () => null, recheckDelayMs: 0,
      });
      await engine.initGenesis();
      await this.api.ledger.audit(scope, 'SIMULATION_STARTED', { by: email, settings: { ...settings }, basePrice: cfg.basePrice.toFixed() }, email);

      const runner = new PairRunner(engine, venue, { shared: this.api.sharedConfig(), ledger: this.api.ledger, alert, log });
      await runner.start();
      if (engine.getStatus() === 'STOPPED') {
        throw new ConflictException('Another paper engine (probably the CLI) is running for this account. Stop it first.');
      }

      const startedAt = Date.now();
      await this.api.pool.query(
        `INSERT INTO engine_paper_settings (owner_id, settings, started_at, stopped_at, stop_reason, updated_at)
         VALUES ($1,$2,now(),NULL,NULL,now())
         ON CONFLICT (owner_id) DO UPDATE SET settings=EXCLUDED.settings, started_at=now(), stopped_at=NULL, stop_reason=NULL, updated_at=now()`,
        [userId, { input: settings, resolved: { basePrice: cfg.basePrice.toFixed(), stepPct: cfg.step.mul(100).toFixed() } }],
      );

      // Automatic stop after N cycles or N hours, if the user asked for one.
      const watchdog = setInterval(() => {
        const snap = engine.snapshot();
        if (settings.maxCycles !== null && snap.cyclesCompleted >= settings.maxCycles) {
          void this.stop(userId, email, `reached ${settings.maxCycles} completed cycles`);
        } else if (settings.maxHours !== null && Date.now() - startedAt >= settings.maxHours * 3_600_000) {
          void this.stop(userId, email, `ran for ${settings.maxHours} hours`);
        }
      }, 10_000);

      this.runs.set(userId, { runner, engine, venue, cfg, specs, startedAt, settings, watchdog });
      this.finished.delete(userId);
      // If the runner ends by itself (lease lost), forget the run.
      void runner.done.then(() => {
        const run = this.runs.get(userId);
        if (run?.runner === runner) {
          clearInterval(run.watchdog);
          this.runs.delete(userId);
        }
      });
      return this.status(userId);
    } finally {
      this.starting.delete(userId);
    }
  }

  async stop(userId: string, email: string, reason = 'stopped by user') {
    const run = this.runs.get(userId);
    if (!run) return this.status(userId);
    this.runs.delete(userId);
    this.finished.set(userId, run);
    clearInterval(run.watchdog);
    await run.runner.stop(reason);
    const scope = run.engine.pairId;
    await this.api.ledger.audit(scope, 'SIMULATION_STOPPED', { by: email, reason }, email);
    await this.api.pool.query(
      'UPDATE engine_paper_settings SET stopped_at=now(), stop_reason=$2, updated_at=now() WHERE owner_id=$1', [userId, reason],
    );
    return this.status(userId);
  }

  /**
   * Independent spec audit of the user's current (or last) run: replays every order, cancel and fill
   * the simulated venue saw against the ledger and checks each rule of the spec.
   */
  async audit(userId: string) {
    const run = this.runs.get(userId) ?? this.finished.get(userId);
    if (!run) throw new NotFoundException('No simulation has run since the backend started. Start one first.');
    const scope = run.engine.pairId;
    const ledger = this.api.ledger;
    const [fills, cycles] = await Promise.all([ledger.listFills(scope), ledger.listCycles(scope)]);
    const rebuilt = rebuildFromFills(run.engine.lattice, fills, run.cfg, run.specs);
    let rebuildMatches = true;
    for (const live of run.engine.getRungs()) {
      const r = rebuilt.rungs.get(live.key);
      if (!r) continue;
      if (live.soldQty.isZero() && live.cycle === r.cycle) continue;
      if (r.cycle !== live.cycle || !owed(r).eq(owed(live))) rebuildMatches = false;
    }
    const kills = (await this.api.pool.query(
      `SELECT detail FROM engine_audit WHERE pair_id=$1 AND kind='KILL' AND ts >= to_timestamp($2/1000.0) ORDER BY id`,
      [scope, run.startedAt],
    )).rows.map((r) => String(r.detail?.reason ?? ''));
    const checks = auditRun({
      cfg: run.cfg, specs: run.specs, lattice: run.engine.lattice, venueLog: run.venue.venueLog, ledgerFills: fills, cycles,
      startBase: new Decimal(run.settings.startZig), startQuote: new Decimal(run.settings.startUsdt), engineKills: kills,
      breaches: run.engine.snapshot().lastBreaches.map((b) => `${b.id}: ${b.message} (${b.left} vs ${b.right})`),
      rebuildMatches, finalStatus: run.engine.getStatus(), expectRunning: this.runs.has(userId),
    });
    const log = run.venue.venueLog;
    return {
      ranAt: new Date().toISOString(),
      running: this.runs.has(userId),
      startedAt: new Date(run.startedAt).toISOString(),
      orders: log.filter((e) => e.kind === 'place' && e.ok).length,
      fills: log.filter((e) => e.kind === 'fill').length,
      cancels: log.filter((e) => e.kind === 'cancel').length,
      cycles: cycles.length,
      passed: checks.filter((c) => c.pass).length,
      failed: checks.filter((c) => !c.pass).length,
      checks,
    };
  }

  async onModuleDestroy() {
    for (const [userId, run] of this.runs) {
      clearInterval(run.watchdog);
      await run.runner.stop('backend shutting down').catch(() => undefined);
      await this.api.pool.query(
        'UPDATE engine_paper_settings SET stopped_at=now(), stop_reason=$2 WHERE owner_id=$1', [userId, 'backend shut down'],
      ).catch(() => undefined);
    }
    this.runs.clear();
  }
}
