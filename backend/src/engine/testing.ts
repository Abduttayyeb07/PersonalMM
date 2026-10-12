import Decimal from 'decimal.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PairConfig, SharedConfig, parsePairConfig, parseSharedConfig } from './config/engine-config';
import { EngineInstance, EngineMode } from './engine-instance';
import { MemoryLedger } from './ledger/memory-ledger';
import { MemoryLease } from './supervisor/lease';
import { Alerter, Clock, VenueSpecs, silentLogger } from './types';
import { SimOptions, SimVenue } from './venue/sim-venue';

/** Shared wiring for tests, backtests and paper runs on the simulated venue. */

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 0, 1)) {}
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
  set(t: number) { this.t = t; }
}

export class CapturingAlerter implements Alerter {
  readonly messages: string[] = [];
  async send(text: string) { this.messages.push(text); }
}

/** Live Bybit ZIGUSDT facts (instruments-info, 12 Oct 2026). The fee is the spec's 0.10% assumption. */
export const BYBIT_ZIG_SPECS: VenueSpecs = {
  tick: new Decimal('0.00001'),
  lot: new Decimal('0.01'),
  minOrderValue: new Decimal('5'),
  makerFee: new Decimal('0.001'),
  buyFeeAsset: 'base',
  maxOpenOrders: 500,
};

const repoPairs = join(__dirname, '..', '..', 'pairs');

export function defaultPairConfig(overrides: Partial<Record<string, unknown>> = {}): PairConfig {
  const cfg = parsePairConfig(readFileSync(join(repoPairs, 'zigusdt-bybit.yaml'), 'utf8'));
  return { ...cfg, ...(overrides as Partial<PairConfig>) };
}

export function defaultSharedConfig(): SharedConfig {
  return parseSharedConfig(readFileSync(join(repoPairs, 'shared.yaml'), 'utf8'));
}

export interface SimRig {
  engine: EngineInstance;
  sim: SimVenue;
  ledger: MemoryLedger;
  lease: MemoryLease;
  clock: FakeClock;
  alerts: CapturingAlerter;
  cfg: PairConfig;
  /** Moves the market, ticks the engine and lets every event settle. */
  step(price: Decimal.Value, advanceMs?: number): Promise<void>;
  attach(engine: EngineInstance): Promise<void>;
}

export interface RigOptions {
  cfg?: PairConfig;
  shared?: SharedConfig;
  specs?: VenueSpecs;
  startPrice: Decimal.Value;
  startBase?: Decimal.Value;
  startQuote?: Decimal.Value;
  sim?: Partial<SimOptions>;
  ledger?: MemoryLedger;
  lease?: MemoryLease;
  clock?: FakeClock;
  existingSim?: SimVenue;
  holder?: string;
  mode?: EngineMode;
}

export function makeEngine(o: {
  cfg: PairConfig; shared: SharedConfig; specs: VenueSpecs; sim: SimVenue; ledger: MemoryLedger;
  lease: MemoryLease; clock: FakeClock; alerts: Alerter; holder?: string; mode?: EngineMode; ownerId?: string;
}) {
  return new EngineInstance({
    ownerId: o.ownerId ?? 'user-a', cfg: o.cfg, shared: o.shared, specs: o.specs, venue: o.sim, ledger: o.ledger, lease: o.lease, alert: o.alerts,
    clock: o.clock, log: silentLogger, holder: o.holder ?? 'test-host', mode: o.mode ?? 'sim', approvedHash: () => null,
  });
}

export async function simRig(o: RigOptions): Promise<SimRig> {
  const cfg = o.cfg ?? defaultPairConfig();
  const shared = o.shared ?? defaultSharedConfig();
  const specs = o.specs ?? BYBIT_ZIG_SPECS;
  const clock = o.clock ?? new FakeClock();
  const ledger = o.ledger ?? new MemoryLedger();
  const lease = o.lease ?? new MemoryLease(clock);
  const alerts = new CapturingAlerter();
  const sim = o.existingSim ?? new SimVenue({
    specs, clock, startPrice: new Decimal(o.startPrice), startBase: new Decimal(o.startBase ?? cfg.maxBaseOwed),
    startQuote: new Decimal(o.startQuote ?? 0), ...o.sim,
  });
  let engine = makeEngine({ cfg, shared, specs, sim, ledger, lease, clock, alerts, holder: o.holder, mode: o.mode });

  const attach = async (e: EngineInstance) => {
    engine = e;
    rig.engine = e;
    await sim.start({
      onBook: (b) => e.onBook(b),
      onFill: (f) => e.onFill(f),
      onOrderUpdate: (u) => e.onOrderUpdate(u),
      onFeedStatus: (feed, c) => e.onFeedStatus(feed, c),
    });
  };

  const rig: SimRig = {
    engine, sim, ledger, lease, clock, alerts, cfg,
    async step(price, advanceMs = 1000) {
      // Behave like the runner: time passes in slices with lease renewal, book updates and ticks.
      for (let left = advanceMs; left > 0; left -= 5000) {
        clock.advance(Math.min(5000, left));
        await rig.engine.renewLease();
        await sim.moveTo(sim.lastPrice);
        await rig.engine.tick();
        await sim.drain();
      }
      await sim.moveTo(new Decimal(price));
      await rig.engine.tick();
      await sim.drain();
      await rig.engine.idle();
      await sim.drain();
    },
    attach,
  };
  await attach(engine);
  return rig;
}
