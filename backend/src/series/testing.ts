import Decimal from 'decimal.js';
import { MemoryLease } from '../engine/supervisor/lease';
import { Alerter, VenueSpecs, silentLogger } from '../engine/types';
import { BYBIT_ZIG_SPECS, CapturingAlerter, FakeClock } from '../engine/testing';
import { SimOptions, SimVenue } from '../engine/venue/sim-venue';
import { SeriesEngine } from './engine';
import { MemorySeriesStore } from './memory-store';
import { buildPlan, defaultSeriesSettings } from './plan';
import { SeriesSettings } from './types';

export { BYBIT_ZIG_SPECS, FakeClock };

/** Bybit BTCUSDT spot rules: price steps of 0.1, quantity steps of 0.000001 BTC, 5 USDT minimum. */
export const BYBIT_BTC_SPECS: VenueSpecs = {
  ...BYBIT_ZIG_SPECS, tick: new Decimal('0.1'), lot: new Decimal('0.000001'), minOrderValue: new Decimal(5),
};

export interface SeriesRig {
  engine: SeriesEngine;
  sim: SimVenue;
  store: MemorySeriesStore;
  clock: FakeClock;
  alerts: CapturingAlerter;
  settings: SeriesSettings;
  /** Moves the market in 5 s slices (lease renewal and ticks included), then settles every event. */
  step(price: Decimal.Value, advanceMs?: number): Promise<void>;
}

export async function seriesRig(o: {
  settings?: Partial<SeriesSettings>;
  startPrice: Decimal.Value;
  specs?: VenueSpecs;
  sim?: Partial<SimOptions>;
  startUsdt?: Decimal.Value;
  feedStaleSeconds?: number;
  symbol?: string;
}): Promise<SeriesRig> {
  const specs = o.specs ?? BYBIT_ZIG_SPECS;
  const settings: SeriesSettings = { ...defaultSeriesSettings(), ...o.settings };
  const clock = new FakeClock();
  const store = new MemorySeriesStore();
  store.now = () => clock.now();
  const alerts = new CapturingAlerter();
  const plan = buildPlan(settings, new Decimal(o.startPrice), specs);
  const startUsdt = new Decimal(o.startUsdt ?? settings.startUsdt);
  const run = await store.createRun({
    ownerId: 'user-a', mode: 'paper', settings, basePrice: plan.basePrice, qty: plan.qty,
    startZig: new Decimal(settings.totalZig), startUsdt, startedAt: clock.now(),
  });
  const sim = new SimVenue({
    specs, clock, startPrice: new Decimal(o.startPrice), startBase: new Decimal(settings.totalZig), startQuote: startUsdt, ...o.sim,
  });
  const engine = new SeriesEngine({
    run, plan, specs, venue: sim, store, lease: new MemoryLease(clock), leaseScope: 'user-a/paper', holder: 'test', clock,
    log: silentLogger, alert: alerts as Alerter, symbol: o.symbol ?? 'ZIGUSDT', feedStaleSeconds: o.feedStaleSeconds ?? 60, leaseTtlSeconds: 15,
  });
  await sim.start({
    onBook: (b) => engine.onBook(b), onFill: (f) => engine.onFill(f),
    onOrderUpdate: (u) => engine.onOrderUpdate(u), onFeedStatus: (f, c) => engine.onFeedStatus(f, c),
  });
  const rig: SeriesRig = {
    engine, sim, store, clock, alerts, settings,
    async step(price, advanceMs = 1000) {
      for (let left = advanceMs; left > 0; left -= 5000) {
        clock.advance(Math.min(5000, left));
        await engine.renewLease();
        await sim.moveTo(sim.lastPrice);
        await engine.tick();
        await sim.drain();
      }
      await sim.moveTo(new Decimal(price));
      await engine.tick();
      await sim.drain();
      await engine.idle();
      await sim.drain();
    },
  };
  return rig;
}
