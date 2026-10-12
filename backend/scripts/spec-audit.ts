/* eslint-disable no-console */
import 'dotenv/config';
import Decimal from 'decimal.js';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { PairConfig, loadPairConfig, loadSharedConfig } from '../src/engine/config/engine-config';
import { candlesFor } from '../src/engine/backtest/candles';
import { auditRun, AuditCheck } from '../src/engine/audit/spec-auditor';
import { rebuildFromFills, owed } from '../src/engine/rung-accounting';
import { BYBIT_ZIG_SPECS, SimRig, makeEngine, simRig } from '../src/engine/testing';
import { SimOptions } from '../src/engine/venue/sim-venue';

/**
 * Spec conformance audit: drives the exact engine code through real and adversarial markets and the
 * spec's failure drills, then has an independent auditor check every rule against what the venue saw.
 *   npm run spec-audit
 */

const D = (v: Decimal.Value) => new Decimal(v);
const specs = BYBIT_ZIG_SPECS;
const shared = loadSharedConfig('pairs/shared.yaml');
const baseCfg = loadPairConfig('pairs/zigusdt-bybit.yaml');

/** Deterministic random numbers so every run is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

type Step = { price: Decimal.Value; ms: number };
type Hook = (rig: SimRig, ctx: { i: number }) => Promise<void>;

interface Scenario {
  name: string;
  what: string;
  cfg: PairConfig;
  startPrice: Decimal.Value;
  startBase: Decimal.Value;
  startQuote?: Decimal.Value;
  sim?: Partial<SimOptions>;
  path: Step[];
  hooks?: Record<number, Hook>;
  expectedKills?: number;
  extraChecks?: (rig: SimRig) => Promise<AuditCheck[]>;
}

/** Plays a path the way the runner would: lease renewal and ticks every slice, a REST poll and a
 * self-healing attempt every 30 s of simulated time. */
async function play(s: Scenario) {
  const rig = await simRig({ cfg: s.cfg, startPrice: s.startPrice, startBase: s.startBase, startQuote: s.startQuote ?? 0, sim: s.sim });
  await rig.engine.initGenesis();
  await rig.engine.start();
  await rig.sim.drain();
  let sincePoll = 0;
  for (let i = 0; i < s.path.length; i++) {
    if (s.hooks?.[i]) await s.hooks[i](rig, { i });
    const step = s.path[i];
    await rig.step(step.price, step.ms);
    sincePoll += step.ms;
    if (sincePoll >= 30_000) {
      sincePoll = 0;
      await rig.engine.poll();
      await rig.engine.recover();
      await rig.sim.drain();
    }
  }
  await rig.engine.checkNow('final');
  return rig;
}

async function runScenario(s: Scenario) {
  const t0 = Date.now();
  const rig = await play(s);
  const fills = await rig.ledger.listFills(rig.engine.pairId);
  const rebuilt = rebuildFromFills(rig.engine.lattice, fills, s.cfg, specs);
  let rebuildMatches = true;
  for (const live of rig.engine.getRungs()) {
    const r = rebuilt.rungs.get(live.key)!;
    if (live.soldQty.isZero() && live.cycle === r.cycle) continue; // unfilled sells leave no fill trace
    if (r.cycle !== live.cycle || !owed(r).eq(owed(live))) rebuildMatches = false;
  }
  const kills = rig.ledger.auditLog.filter((e) => e.kind === 'KILL').map((e) => String(e.detail.reason));
  const checks = auditRun({
    cfg: s.cfg, specs, lattice: rig.engine.lattice, venueLog: rig.sim.log, ledgerFills: fills, cycles: rig.engine.getCycles(),
    startBase: D(s.startBase), startQuote: D(s.startQuote ?? 0), engineKills: kills, expectedKills: s.expectedKills,
    breaches: rig.engine.snapshot().lastBreaches.map((b) => `${b.id}: ${b.message} (${b.left} vs ${b.right})`),
    rebuildMatches, finalStatus: rig.engine.getStatus(),
  });
  if (s.extraChecks) checks.push(...(await s.extraChecks(rig)));
  const snap = rig.engine.snapshot();
  return {
    name: s.name, what: s.what, checks, seconds: (Date.now() - t0) / 1000,
    summary: `${snap.cyclesCompleted} cycles · profit $${new Decimal(snap.profitSinceSweep).toFixed(2)} · ${rig.sim.log.filter((e) => e.kind === 'place' && e.ok).length} orders · ${rig.sim.log.filter((e) => e.kind === 'fill').length} fills · ${kills.length} kill(s) · netted ${rig.ledger.auditLog.filter((e) => e.kind === 'NETTED').length} · partial-sell exceptions ${rig.ledger.auditLog.filter((e) => e.kind === 'PARTIAL_SELL_EXCEPTION').length}`,
    kills,
  };
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────

function candlePath(candles: Awaited<ReturnType<typeof candlesFor>>): Step[] {
  const steps: Step[] = [];
  for (const c of candles) {
    const way = c.close.gte(c.open) ? [c.open, c.low, c.high, c.close] : [c.open, c.high, c.low, c.close];
    for (const p of way) steps.push({ price: p, ms: 15_000 });
  }
  return steps;
}

/** Oscillates around the base, landing exactly on rung prices, with noise. */
function oscillation(seed: number, n: number): Step[] {
  const r = rng(seed);
  const anchors = [0.06, 0.0609, 0.0618, 0.0627, 0.0618, 0.0609, 0.06, 0.05913, 0.05825, 0.0574, 0.05825, 0.05913];
  const out: Step[] = [];
  for (let i = 0; i < n; i++) {
    const a = anchors[i % anchors.length];
    const noise = (r() - 0.5) * 0.0004;
    out.push({ price: D(a + (r() < 0.4 ? 0 : noise)).toDecimalPlaces(5), ms: 7_000 });
  }
  return out;
}

/** Violent moves: gaps through many rungs, below the floor, above the top, and back. */
function gaps(): Step[] {
  const pts = [0.06, 0.0645, 0.0611, 0.051, 0.046, 0.0499, 0.0575, 0.0995, 0.112, 0.0702, 0.0598, 0.0632, 0.0571, 0.0612, 0.0589, 0.0601];
  const out: Step[] = [];
  for (let rep = 0; rep < 3; rep++) for (const p of pts) out.push({ price: p, ms: 20_000 }, { price: p, ms: 20_000 });
  return out;
}

function flat(price: number, n: number, ms = 10_000): Step[] {
  return Array.from({ length: n }, () => ({ price, ms }));
}

function randomPartials(seed: number): SimOptions['partialFill'] {
  const r = rng(seed);
  return ({ remaining }) => {
    if (r() < 0.35) {
      const part = remaining.mul(0.3 + r() * 0.4).toDecimalPlaces(2, Decimal.ROUND_DOWN);
      return part.isPositive() ? part : remaining;
    }
    return remaining;
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const only = process.argv[2];
  const candles = await candlesFor(baseCfg.symbol, 30, join('engine-data', `${baseCfg.symbol}-1m-30d.csv`));
  const real = candlePath(candles);
  const small: PairConfig = { ...baseCfg, rungSizeBase: D(500), maxBaseOwed: D(5000) };
  const mid = { ...baseCfg, rungSizeBase: D(1000), maxBaseOwed: D(47000) };

  const scenarios: Scenario[] = [
    { name: 'real-30d-default', what: '30 days of real ZIGUSDT minutes, spec config (12,500 ZIG rungs)', cfg: baseCfg, startPrice: candles[0].open, startBase: baseCfg.maxBaseOwed, path: real },
    { name: 'real-30d-5000zig', what: '30 days of real minutes, your paper setup: 5,000 ZIG, 500 ZIG rungs', cfg: small, startPrice: candles[0].open, startBase: 5000, path: real },
    { name: 'stress-oscillation', what: 'Price lands exactly on rung prices again and again, 3-tick spread, random partial fills, lagging public book', cfg: mid, startPrice: 0.06, startBase: 47000, sim: { spreadTicks: 3, ownOrdersInBook: false, partialFill: randomPartials(7) }, path: oscillation(11, 6000) },
    { name: 'stress-gaps', what: 'Gaps through many rungs, below the floor, above the top, with partial fills', cfg: mid, startPrice: 0.06, startBase: 47000, sim: { spreadTicks: 2, partialFill: randomPartials(3) }, path: gaps() },
    {
      name: 'drill-crash-mid-fill', what: 'Engine dies; sells fill while it is down; a standby takes over', cfg: mid, startPrice: 0.06, startBase: 47000,
      path: [...flat(0.06, 6), { price: 0.0645, ms: 10_000 }, ...flat(0.0645, 8), { price: 0.0590, ms: 10_000 }, ...flat(0.059, 8)],
      hooks: {
        6: async (rig) => {
          rig.sim.detach();
          await rig.sim.moveTo(D('0.0645')); // fills while nobody listens
          rig.clock.advance(20_000); // lease expires
          const standby = makeEngine({ cfg: mid, shared, specs, sim: rig.sim, ledger: rig.ledger, lease: rig.lease, clock: rig.clock, alerts: rig.alerts, holder: 'standby' });
          await rig.attach(standby);
          await standby.start();
          await rig.sim.drain();
        },
      },
    },
    {
      name: 'drill-private-ws-cut-5min', what: 'Private fill feed cut for 5 minutes while fills happen; REST poll and self-healing must recover', cfg: mid, startPrice: 0.06, startBase: 47000,
      path: [...flat(0.06, 3), { price: 0.0624, ms: 10_000 }, ...flat(0.0624, 29), ...flat(0.0624, 6)],
      hooks: {
        3: async (rig) => { rig.sim.dropPrivateFeed = true; await rig.engine.onFeedStatus('private', false); },
        33: async (rig) => { rig.sim.dropPrivateFeed = false; await rig.engine.onFeedStatus('private', true); },
      },
      expectedKills: 1,
      extraChecks: async (rig) => {
        const fills = await rig.ledger.listFills(rig.engine.pairId);
        return [{ id: 'DRILL', rule: 'Drill: fills made during the outage are in the ledger and the engine resumed on its own', pass: fills.length >= rig.sim.allFills.length && rig.engine.getStatus() === 'RUNNING', detail: `${fills.length}/${rig.sim.allFills.length} fills recorded, status ${rig.engine.getStatus()}` }];
      },
    },
    {
      name: 'drill-market-ws-cut-5min', what: 'Market data cut for 5 minutes: the engine must stop trading blind, then recover on its own', cfg: mid, startPrice: 0.06, startBase: 47000,
      path: [...flat(0.06, 3), ...flat(0.06, 12)],
      hooks: {
        3: async (rig) => {
          await rig.engine.onFeedStatus('market', false);
          // Five minutes with no market data at all.
          for (let t = 0; t < 300_000; t += 5_000) {
            rig.clock.advance(5_000);
            await rig.engine.renewLease();
            await rig.engine.tick();
            if (t % 30_000 === 0) await rig.engine.recover();
            await rig.sim.drain();
          }
          await rig.engine.onFeedStatus('market', true);
        },
      },
      expectedKills: 1,
      extraChecks: async (rig) => [{ id: 'DRILL', rule: 'Drill: stopped while blind, resumed on its own when data returned', pass: rig.ledger.auditLog.some((e) => e.kind === 'KILL') && rig.engine.getStatus() === 'RUNNING', detail: `kills ${rig.ledger.auditLog.filter((e) => e.kind === 'KILL').length}, final status ${rig.engine.getStatus()}` }],
    },
    {
      name: 'drill-second-instance', what: 'A second engine for the same pair starts while the first runs', cfg: mid, startPrice: 0.06, startBase: 47000,
      path: [...flat(0.06, 4), { price: 0.0625, ms: 10_000 }, ...flat(0.0625, 4)],
      extraChecks: async (rig) => {
        const before = rig.sim.log.length;
        const rogue = makeEngine({ cfg: mid, shared, specs, sim: rig.sim, ledger: rig.ledger, lease: rig.lease, clock: rig.clock, alerts: rig.alerts, holder: 'rogue' });
        const status = await rogue.start();
        await rogue.onBook(await rig.sim.getBook());
        await rogue.tick();
        const placed = rig.sim.log.slice(before).filter((e) => e.kind === 'place').length;
        return [{ id: 'DRILL', rule: 'Drill: the second instance never places an order', pass: status === 'STOPPED' && placed === 0, detail: `second instance status ${status}, orders placed ${placed}` }];
      },
    },
    {
      name: 'drill-duplicate-fill-and-rate-limits', what: 'Every fill replayed twice; bursts of rate-limit errors during placement', cfg: mid, startPrice: 0.06, startBase: 47000,
      path: [...flat(0.06, 3), { price: 0.0628, ms: 10_000 }, ...flat(0.0628, 10), { price: 0.0595, ms: 10_000 }, ...flat(0.0595, 10)],
      hooks: {
        2: async (rig) => { rig.sim.rateLimitNext = 25; },
        14: async (rig) => {
          const before = rig.engine.getRungs();
          for (const f of rig.sim.allFills) await rig.engine.onFill(f);
          await rig.sim.drain();
          if (JSON.stringify(before) !== JSON.stringify(rig.engine.getRungs())) throw new Error('duplicate fills changed rung state');
        },
      },
    },
  ];

  const results: Array<{ name: string; what: string; checks: AuditCheck[]; seconds: number; summary: string; kills: string[] }> = [];
  for (const s of scenarios) {
    if (only && !s.name.includes(only)) continue;
    process.stdout.write(`▶ ${s.name} … `);
    try {
      const r = await runScenario(s);
      const failed = r.checks.filter((c) => !c.pass);
      console.log(failed.length ? `FAIL (${failed.length})` : 'PASS', `[${r.seconds.toFixed(1)}s] ${r.summary}`);
      for (const c of failed) console.log(`    ✗ ${c.id} ${c.rule}\n      ${c.detail}`);
      if (r.kills.length) console.log(`    kills: ${r.kills.join(' / ').slice(0, 300)}`);
      results.push(r);
    } catch (e) {
      console.log('ERROR', (e as Error).message);
      results.push({ name: s.name, what: s.what, checks: [{ id: 'ERROR', rule: 'Scenario ran to completion', pass: false, detail: (e as Error).message }], seconds: 0, summary: 'crashed', kills: [] });
    }
  }
  mkdirSync('engine-data', { recursive: true });
  const md = ['# Spec conformance audit', '', `Run ${new Date().toISOString()}`, ''];
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.pass).length;
    md.push(`## ${r.name}: ${failed ? `FAIL (${failed})` : 'PASS'}`, '', `${r.what}. ${r.summary}`, '', '| Check | Result | Evidence |', '|---|---|---|');
    for (const c of r.checks) md.push(`| ${c.rule} | ${c.pass ? 'pass' : '**FAIL**'} | ${c.detail.replace(/\|/g, '/')} |`);
    md.push('');
  }
  writeFileSync(join('engine-data', 'spec-audit.md'), md.join('\n'));
  const total = results.reduce((n, r) => n + r.checks.filter((c) => !c.pass).length, 0);
  console.log(`\n${total ? `${total} failing check(s)` : 'ALL CHECKS PASS'} — report: engine-data/spec-audit.md`);
  if (total) process.exitCode = 1;
}

void main();
