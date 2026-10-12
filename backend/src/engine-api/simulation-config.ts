import Decimal from 'decimal.js';
import { PairConfig } from '../engine/config/engine-config';

/** What a user sets on the Simulation page. Numbers travel as strings to keep them exact. */
export interface SimSettings {
  startZig: string;
  startUsdt: string;
  rungSize: string;
  stepPct: string;
  ladders: 1 | 2;
  /** null = start the lattice at the current market price. */
  basePrice: string | null;
  floorPrice: string;
  topPrice: string;
  /** Optional automatic stop. */
  maxCycles: number | null;
  maxHours: number | null;
}

export class SimSettingsError extends Error {}

const dec = (v: unknown, name: string) => {
  try {
    const d = new Decimal(String(v));
    if (!d.isFinite()) throw new Error();
    return d;
  } catch {
    throw new SimSettingsError(`${name} must be a number`);
  }
};

export function defaultSimSettings(base: PairConfig): SimSettings {
  return {
    startZig: base.maxBaseOwed.toFixed(),
    startUsdt: '0',
    rungSize: base.rungSizeBase.toFixed(),
    stepPct: base.step.mul(100).toFixed(),
    ladders: base.ladders.length >= 2 ? 2 : 1,
    basePrice: null,
    floorPrice: base.floorPrice.toFixed(),
    topPrice: base.topPrice.toFixed(),
    maxCycles: null,
    maxHours: null,
  };
}

/**
 * Turns the user's settings into an engine config for their paper run. Every value is bounded so a
 * typo cannot produce a nonsense lattice.
 */
export function buildSimConfig(base: PairConfig, s: SimSettings, marketPrice: Decimal, minOrderValue: Decimal): PairConfig {
  const startZig = dec(s.startZig, 'Starting ZIG');
  const startUsdt = dec(s.startUsdt, 'Starting USDT');
  const rungSize = dec(s.rungSize, 'Rung size');
  const step = dec(s.stepPct, 'Step').div(100);
  const floor = dec(s.floorPrice, 'Floor price');
  const top = dec(s.topPrice, 'Top price');
  const basePrice = s.basePrice === null || s.basePrice === '' ? marketPrice : dec(s.basePrice, 'Base price');

  if (startZig.lt(1) || startZig.gt(1e9)) throw new SimSettingsError('Starting ZIG must be between 1 and 1,000,000,000');
  if (startUsdt.isNegative() || startUsdt.gt(1e8)) throw new SimSettingsError('Starting USDT must be between 0 and 100,000,000');
  if (rungSize.lte(0) || rungSize.gt(startZig)) throw new SimSettingsError('Rung size must be positive and no larger than the starting ZIG');
  if (step.lt('0.005') || step.gt('0.2')) throw new SimSettingsError('Step must be between 0.5% and 20%');
  if (![1, 2].includes(s.ladders)) throw new SimSettingsError('Ladders must be 1 or 2');
  if (floor.lte(0) || floor.gte(top)) throw new SimSettingsError('Floor must be above 0 and below the top price');
  if (basePrice.lt(floor) || basePrice.gt(top)) {
    throw new SimSettingsError(`Base price ${basePrice.toFixed()} must sit between the floor and the top`);
  }
  if (rungSize.mul(floor).lt(minOrderValue)) {
    throw new SimSettingsError(`A rung at the floor is worth ${rungSize.mul(floor).toFixed(2)} USDT; Bybit's minimum order is ${minOrderValue} USDT. Increase the rung size or the floor.`);
  }
  if (s.maxCycles !== null && (!Number.isInteger(s.maxCycles) || s.maxCycles < 1)) throw new SimSettingsError('Stop after cycles must be a whole number of at least 1');
  if (s.maxHours !== null && (!(s.maxHours > 0) || s.maxHours > 24 * 90)) throw new SimSettingsError('Stop after hours must be between 0 and 2160');

  const ladders = s.ladders === 2
    ? [{ name: 'A', offset: new Decimal(0) }, { name: 'B', offset: step.div(2) }]
    : [{ name: 'A', offset: new Decimal(0) }];

  return {
    ...base,
    pairId: `${base.pairId}-PAPER`,
    basePrice,
    floorPrice: floor,
    topPrice: top,
    step,
    ladders,
    rungSizeBase: rungSize,
    // Never more on sale than the simulated account holds.
    maxBaseOwed: startZig,
  };
}
