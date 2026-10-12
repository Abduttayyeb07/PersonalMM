/* eslint-disable no-console */
import axios from 'axios';
import Decimal from 'decimal.js';
import { hostname } from 'os';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../encryption/encryption.service';
import {
  PairConfig, SharedConfig, approvalProblem, configHash, loadApprovals, loadPairConfig, loadSharedConfig,
} from './config/engine-config';
import { EngineInstance, EngineMode, scopeId } from './engine-instance';
import { candlesFor, medianHourlyVolume } from './backtest/candles';
import { runBacktest } from './backtest/backtest';
import { buildLattice } from './lattice';
import { createPool, migrate } from './ledger/db';
import { PgLedger } from './ledger/pg-ledger';
import { owed } from './rung-accounting';
import { reserveOf } from './invariants';
import { weeklyReport } from './reports';
import { PgLease } from './supervisor/lease';
import { PairRunner, summaryText } from './supervisor/runner';
import { BYBIT_ZIG_SPECS } from './testing';
import { Alerter, Logger, VenueSpecs, systemClock } from './types';
import { BybitVenue } from './venue/bybit-venue';
import { PaperVenue } from './venue/paper-venue';
import { VenueAdapter } from './venue/venue';

type Arg = (name: string, fallback?: string) => string | undefined;
type Flag = (name: string) => boolean;

const log: Logger = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

/** Telegram channel for kill-switch pages and daily summaries. Messages never contain key material. */
class TelegramAlerter implements Alerter {
  constructor(private readonly who: string) {}
  async send(text: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_ADMIN_ID;
    const line = `[${this.who}] ${text}`;
    log.info(`ALERT ${line.replace(/\n/g, ' | ')}`);
    if (!token || !chat) return;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: line }).catch((e) => log.warn(`alert failed: ${e.message}`));
  }
}

function load(arg: Arg): { cfg: PairConfig; shared: SharedConfig; approvalsPath: string } {
  const cfg = loadPairConfig(arg('pair', 'pairs/zigusdt-bybit.yaml')!);
  const shared = loadSharedConfig(arg('shared', 'pairs/shared.yaml')!);
  return { cfg, shared, approvalsPath: arg('approvals', 'pairs/approvals.json')! };
}

/** Resolves --user <email> to the app user. Every engine command acts for exactly one user. */
async function ownerOf(pool: Pool, arg: Arg): Promise<{ id: string; email: string }> {
  const email = arg('user');
  if (!email) throw new Error('--user <email> is required: each user runs their own independent engine');
  const { rows } = await pool.query('SELECT id, email FROM users WHERE email=$1', [email]);
  if (!rows[0]) throw new Error(`no user ${email}`);
  return rows[0];
}

/**
 * The user's OWN key, as connected in the app. It is AES-256-GCM encrypted and bound to that user by
 * AAD, so one user's engine cannot decrypt another user's key. Decrypted only to build the adapter.
 */
async function userCredentials(pool: Pool, userId: string, exchange: string) {
  const { rows } = await pool.query(
    'SELECT encrypted_api_key, encrypted_api_secret FROM exchange_credentials WHERE user_id=$1 AND exchange=$2',
    [userId, exchange],
  );
  if (!rows[0]) throw new Error(`this user has not connected a ${exchange} key in the app`);
  const encryption = new EncryptionService(new ConfigService(process.env));
  const aad = `${userId}:${exchange}`;
  return {
    apiKey: encryption.decrypt(rows[0].encrypted_api_key, aad),
    apiSecret: encryption.decrypt(rows[0].encrypted_api_secret, aad),
  };
}

async function liveVenue(pool: Pool, userId: string, cfg: PairConfig): Promise<BybitVenue> {
  if (cfg.venue !== 'bybit') throw new Error(`no adapter for venue ${cfg.venue}`);
  const creds = await userCredentials(pool, userId, 'bybit');
  return new BybitVenue({ symbol: cfg.symbol, baseAsset: cfg.baseAsset, quoteAsset: cfg.quoteAsset, ...creds, log, smpType: 'CancelTaker' });
}

async function publicSpecs(cfg: PairConfig): Promise<{ specs: VenueSpecs; note?: string }> {
  // Tick, lot and minimum come from the venue. The fee needs a key; without one we use the spec's 0.10%.
  const { data } = await axios.get('https://api.bybit.com/v5/market/instruments-info', { params: { category: 'spot', symbol: cfg.symbol }, timeout: 10_000 });
  const info = data?.result?.list?.[0];
  if (!info) throw new Error(`${cfg.symbol} not found on Bybit`);
  return {
    specs: {
      ...BYBIT_ZIG_SPECS,
      tick: new Decimal(info.priceFilter.tickSize),
      lot: new Decimal(info.lotSizeFilter.basePrecision),
      minOrderValue: new Decimal(info.lotSizeFilter.minOrderAmt),
    },
    note: 'maker fee assumed 0.10% (run with --with-keys --user to pull the account fee tier)',
  };
}

async function withDb<T>(fn: (pool: Pool, ledger: PgLedger) => Promise<T>): Promise<T> {
  const pool = createPool();
  try {
    await migrate(pool);
    return await fn(pool, new PgLedger(pool));
  } finally {
    await pool.end();
  }
}

/** The engine scope this command targets for the user: `<userId>/<pairId>`, `<userId>/<pairId>-PAPER` or `<userId>/*`. */
function targetScope(userId: string, cfg: PairConfig, flag: Flag, allowAll = false): string {
  if (allowAll && flag('all')) return scopeId(userId, '*');
  return scopeId(userId, flag('paper') ? `${cfg.pairId}-PAPER` : cfg.pairId);
}

export async function runCommand(cmd: string | undefined, arg: Arg, flag: Flag) {
  switch (cmd) {
    case 'migrate':
      return withDb(async () => console.log('engine schema is up to date'));

    case 'hash':
      return withDb(async (pool) => {
        const { cfg, approvalsPath } = load(arg);
        const user = await ownerOf(pool, arg);
        const scope = scopeId(user.id, cfg.pairId);
        console.log(`config hash for ${scope} (${user.email}): ${configHash(cfg)}`);
        const problem = approvalProblem(cfg, loadApprovals(approvalsPath), scope);
        console.log(problem ? `NOT approved for live: ${problem}` : 'approved for live trading');
      });

    case 'approve':
      return withDb(async (pool) => {
        // Writes the approval entry; it takes effect through a reviewed commit of approvals.json.
        const { cfg, approvalsPath } = load(arg);
        const user = await ownerOf(pool, arg);
        const scope = scopeId(user.id, cfg.pairId);
        const approvers = (arg('approvers') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
        if (new Set(approvers.map((a) => a.toLowerCase())).size < 2) throw new Error('--approvers needs two distinct names, e.g. "bilal,zahoor"');
        const approvals = loadApprovals(approvalsPath);
        approvals[scope] = { hash: configHash(cfg), approvers, approvedAt: new Date().toISOString() };
        writeFileSync(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`);
        console.log(`recorded approval of ${scope} hash ${approvals[scope].hash} by ${approvers.join(' and ')}; commit ${approvalsPath} through review`);
      });

    case 'onboard': {
      const { cfg, shared } = load(arg);
      const { specs, note } = flag('with-keys')
        ? await withDb(async (pool) => ({ specs: await (await liveVenue(pool, (await ownerOf(pool, arg)).id, cfg)).getSpecs(), note: undefined as string | undefined }))
        : await publicSpecs(cfg);
      const candles = await candlesFor(cfg.symbol, 30, join('engine-data', `${cfg.symbol}-1m-30d.csv`), flag('refresh'));
      const lattice = buildLattice(cfg, specs);
      const mhv = medianHourlyVolume(candles);
      const floorValue = cfg.rungSizeBase.mul(cfg.floorPrice);
      const tickPct = specs.tick.div(cfg.floorPrice).mul(100);
      const rungPct = mhv.isZero() ? new Decimal(Infinity) : cfg.rungSizeBase.div(mhv).mul(100);
      const bt = await runBacktest({ label: 'onboarding', cfg, shared, specs, candles, startBase: cfg.maxBaseOwed });
      const checks: Array<[string, boolean, string]> = [
        ['Venue specs pulled by the adapter', true, `tick ${specs.tick}, lot ${specs.lot}, min value ${specs.minOrderValue}, maker ${specs.makerFee}, buy fee in ${specs.buyFeeAsset}${note ? ` (${note})` : ''}`],
        ['Rung value at the floor is comfortably above the minimum order', floorValue.gte(specs.minOrderValue.mul(cfg.onboarding.minOrderValueMultiple)), `${floorValue.toFixed(2)} vs ${specs.minOrderValue} x ${cfg.onboarding.minOrderValueMultiple}`],
        ['One tick <= threshold % of the floor price', tickPct.lte(cfg.onboarding.maxTickPctOfFloor), `${tickPct.toFixed(4)}% vs ${cfg.onboarding.maxTickPctOfFloor}%`],
        ['Rung size <= threshold % of median hourly volume (30d)', rungPct.lte(cfg.onboarding.maxRungPctOfHourlyVolume), `${rungPct.toFixed(2)}% of ${mhv.toFixed(0)} ${cfg.baseAsset}/h vs ${cfg.onboarding.maxRungPctOfHourlyVolume}%`],
        ['30-day backtest passes', bt.kills === 0 && bt.status === 'RUNNING', `${bt.cyclesCompleted} cycles (${bt.cyclesPerWeek}/week), $${bt.realisedProfitUsd}, status ${bt.status}`],
        ['Leadership sign-off on base, floor, top, rung size, cap', false, 'manual: record with `approve --user <email> --approvers a,b`'],
        ['7 days at small size with no unexplained kill', false, 'manual: testing stage 3'],
      ];
      console.log(`Onboarding ${cfg.pairId}: ${lattice.length} rungs, max base owed ${cfg.maxBaseOwed}`);
      for (const [name, ok, detail] of checks) console.log(`${ok ? '[x]' : '[ ]'} ${name} - ${detail}`);
      return;
    }

    case 'init':
      return withDb(async (pool, ledger) => {
        const { cfg } = load(arg);
        const user = await ownerOf(pool, arg);
        const scope = scopeId(user.id, cfg.pairId);
        if (await ledger.getGenesis(scope)) return console.log(`${scope} already has a genesis; it is never overwritten`);
        const b = await (await liveVenue(pool, user.id, cfg)).getBalances();
        await ledger.setGenesis(scope, { baseAtStart: b.base, quoteAtStart: b.quote, createdAt: Date.now() });
        await ledger.audit(scope, 'GENESIS', { base: b.base.toFixed(), quote: b.quote.toFixed() }, arg('by') ?? user.email);
        console.log(`genesis recorded for ${user.email} ${cfg.pairId}: ${b.base} ${cfg.baseAsset}, ${b.quote} ${cfg.quoteAsset}`);
      });

    case 'run': {
      const mode = arg('mode', 'paper') as EngineMode;
      if (mode !== 'paper' && mode !== 'live') throw new Error('--mode must be paper or live');
      const loaded = load(arg);
      const shared = loaded.shared;
      const pool = createPool();
      await migrate(pool);
      const ledger = new PgLedger(pool);
      const lease = new PgLease(pool);
      const user = await ownerOf(pool, arg);
      const alert = new TelegramAlerter(user.email);
      const holder = arg('holder', `${hostname()}:${process.pid}`)!;
      let cfg = loaded.cfg;
      let venue: VenueAdapter;
      let specs: VenueSpecs;

      if (mode === 'live') {
        const problem = approvalProblem(cfg, loadApprovals(loaded.approvalsPath), scopeId(user.id, cfg.pairId));
        if (problem) throw new Error(`refusing to trade live: ${problem}`);
        if (process.env.ENGINE_LIVE_CONFIRM !== cfg.pairId) throw new Error(`set ENGINE_LIVE_CONFIRM=${cfg.pairId} to trade real funds`);
        const bybit = await liveVenue(pool, user.id, cfg);
        specs = await bybit.getSpecs();
        venue = bybit;
      } else {
        // Paper rows never mix with live ones, and never with another user's.
        cfg = { ...cfg, pairId: `${cfg.pairId}-PAPER` };
        specs = (await publicSpecs(cfg)).specs;
        const ticker = await axios.get('https://api.bybit.com/v5/market/tickers', { params: { category: 'spot', symbol: cfg.symbol }, timeout: 10_000 });
        const startPrice = new Decimal(ticker.data.result.list[0].lastPrice);
        const paperScope = scopeId(user.id, cfg.pairId);
        if (!flag('fresh') && (await ledger.getGenesis(paperScope))) {
          throw new Error('paper balances live in memory; restart paper runs with --fresh');
        }
        for (const table of ['engine_rungs', 'engine_fills', 'engine_cycles', 'engine_genesis', 'engine_control']) {
          await pool.query(`DELETE FROM ${table} WHERE pair_id=$1`, [paperScope]); // only this user's paper rows
        }
        venue = new PaperVenue({
          symbol: cfg.symbol, specs, clock: systemClock, log, startPrice,
          startBase: new Decimal(arg('base', cfg.maxBaseOwed.toFixed())!), startQuote: new Decimal(arg('quote', '0')!),
        });
      }

      const approvedHash = () => loadApprovals(loaded.approvalsPath)[scopeId(user.id, loaded.cfg.pairId)]?.hash ?? null;
      const engine = new EngineInstance({
        ownerId: user.id, cfg, shared, specs, venue, ledger, lease, alert, clock: systemClock, log, holder, mode, approvedHash,
        recheckDelayMs: mode === 'live' ? 2000 : 0,
      });
      if (mode === 'paper') await engine.initGenesis();
      const runner = new PairRunner(engine, venue, { shared, ledger, alert, log });
      const shutdown = async () => { await runner.stop('signal'); await pool.end(); process.exit(0); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      await runner.start();
      await runner.done;
      await pool.end();
      return;
    }

    case 'status':
      return withDb(async (pool, ledger) => {
        const { cfg } = load(arg);
        const user = await ownerOf(pool, arg);
        const pairId = targetScope(user.id, cfg, flag);
        const rungs = await ledger.loadRungs(pairId);
        const cycles = await ledger.listCycles(pairId);
        const sweeps = await ledger.sumSweeps(pairId);
        const lease = (await pool.query('SELECT holder, epoch, expires_at FROM engine_leases WHERE pair_id=$1', [pairId])).rows[0];
        const killed = await ledger.isKilled(pairId);
        const recent = (await pool.query('SELECT ts, kind, detail FROM engine_audit WHERE pair_id=$1 ORDER BY id DESC LIMIT 8', [pairId])).rows;
        const byState: Record<string, number> = { IDLE: 0, SELL_LIVE: 0, BUY_LIVE: 0 };
        for (const r of rungs) byState[r.state] += 1;
        const profit = cycles.reduce((s, c) => s.plus(c.profit), new Decimal(0));
        const leaseLive = lease && new Date(lease.expires_at) > new Date();
        console.log(summaryText({
          pairId: `${user.email} ${pairId.split('/')[1]}`,
          status: killed ? 'KILLED' : leaseLive ? 'RUNNING' : 'STOPPED',
          statusReason: lease ? `lease ${lease.holder} epoch ${lease.epoch}` : 'no lease', epoch: lease ? Number(lease.epoch) : null,
          book: null, rungsByState: byState, baseOwed: rungs.reduce((s, r) => s.plus(owed(r)), new Decimal(0)).toFixed(),
          reserve: reserveOf(rungs).toFixed(2), profitSinceSweep: profit.minus(sweeps).toFixed(2), cyclesCompleted: cycles.length,
          liveOrders: rungs.filter((r) => r.order).length, lastInvariantCheck: null, lastBreaches: [],
        }, 'Status'));
        console.log('\nRecent audit:');
        for (const e of recent) console.log(`  ${new Date(e.ts).toISOString()} ${e.kind} ${JSON.stringify(e.detail)}`);
      });

    case 'kill':
      return withDb(async (pool, ledger) => {
        const { cfg } = load(arg);
        const user = await ownerOf(pool, arg);
        const by = arg('by');
        if (!by) throw new Error('--by <name> is required');
        // --all stops every pair of THIS user only; other users are never affected.
        const target = targetScope(user.id, cfg, flag, true);
        await ledger.setKilled(target, true, by);
        await ledger.audit(target, 'KILL_REQUESTED', { by, target }, by);
        console.log(`kill switch set for ${user.email} (${target.split('/')[1]}); running engines cancel all orders within a second`);
        if (flag('cancel-now') && !flag('paper')) {
          await (await liveVenue(pool, user.id, cfg)).cancelAll();
          console.log('cancelled every open order on the venue directly');
        }
      });

    case 'resume':
      return withDb(async (pool, ledger) => {
        const { cfg } = load(arg);
        const user = await ownerOf(pool, arg);
        const by = arg('by');
        if (!by) throw new Error('--by <name> is required');
        const target = targetScope(user.id, cfg, flag, true);
        await ledger.setKilled(target, false, by);
        await ledger.audit(target, 'RESUME_REQUESTED', { by, target }, by);
        console.log(`kill switch cleared for ${user.email} (${target.split('/')[1]}); the running engine re-runs the restart procedure`);
      });

    case 'report':
      return withDb(async (pool, ledger) => {
        const { cfg } = load(arg);
        const user = await ownerOf(pool, arg);
        console.log(JSON.stringify(await weeklyReport(ledger, pool, targetScope(user.id, cfg, flag)), null, 2));
      });

    case 'sweep':
      return withDb(async (pool, ledger) => {
        // Records profit a human has ALREADY moved out. The engine never moves funds.
        const { cfg } = load(arg);
        const user = await ownerOf(pool, arg);
        const scope = scopeId(user.id, cfg.pairId);
        const amount = new Decimal(arg('amount') ?? 'NaN');
        const approvers = (arg('approvers') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
        if (!amount.isFinite() || !amount.isPositive()) throw new Error('--amount must be positive');
        if (new Set(approvers.map((a) => a.toLowerCase())).size < 2) throw new Error('a sweep needs two distinct approvers');
        const cycles = await ledger.listCycles(scope);
        const unswept = cycles.reduce((s, c) => s.plus(c.profit), new Decimal(0)).minus(await ledger.sumSweeps(scope));
        if (amount.gt(unswept)) throw new Error(`only ${unswept.toFixed(2)} of profit is unswept; reserve is never withdrawn`);
        await ledger.addSweep(scope, amount, approvers);
        await ledger.audit(scope, 'SWEEP', { amount: amount.toFixed(), approvers }, approvers.join(','));
        console.log(`recorded sweep of ${amount} ${cfg.quoteAsset} for ${user.email}, approved by ${approvers.join(' and ')}`);
      });

    default:
      console.log([
        'Commands (all except backtest/onboard take --user <email>; users never share keys, data or controls):',
        '  backtest [--days 30] [--refresh]                 replay real Bybit 1-minute candles (live config vs step 2%)',
        '  onboard [--with-keys --user e]                   run the onboarding checklist',
        '  hash | approve --approvers a,b                   config hash / record two approvals (commit the file)',
        '  migrate                                          create engine tables (plain SQL in backend/sql)',
        '  init                                             record genesis balances from the user\'s Bybit key (once)',
        '  run --mode paper|live [--fresh] [--base N]       run the engine (paper: live data, simulated fills)',
        '  status [--paper]                                 rungs, owed, reserve, profit, lease, recent audit',
        '  kill --by name [--all] [--paper] [--cancel-now]  kill switch (--all = every pair of this user)',
        '  resume --by name [--all] [--paper]               clear the kill switch',
        '  report [--paper]                                 weekly report',
        '  sweep --amount X --approvers a,b                 record profit already withdrawn by humans',
      ].join('\n'));
  }
}
