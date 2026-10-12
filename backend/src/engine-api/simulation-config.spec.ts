import Decimal from 'decimal.js';
import { buildSimConfig, defaultSimSettings, SimSettingsError } from './simulation-config';
import { defaultPairConfig } from '../engine/testing';

const base = defaultPairConfig();
const ok = { ...defaultSimSettings(base), startZig: '200000', rungSize: '5000' };
const build = (s: Partial<typeof ok>) => buildSimConfig(base, { ...ok, ...s }, new Decimal('0.059'), new Decimal('5'));

describe('simulation settings', () => {
  it('builds a paper config anchored at the market when no base price is given', () => {
    const cfg = build({});
    expect(cfg.pairId).toBe('ZIGUSDT-BYBIT-PAPER');
    expect(cfg.basePrice.toFixed()).toBe('0.059');
    expect(cfg.maxBaseOwed.toFixed()).toBe('200000');
    expect(cfg.ladders.map((l) => [l.name, l.offset.toFixed()])).toEqual([['A', '0'], ['B', '0.015']]);
  });

  it('supports one ladder and a custom step', () => {
    const cfg = build({ ladders: 1, stepPct: '2' });
    expect(cfg.ladders).toHaveLength(1);
    expect(cfg.step.toFixed()).toBe('0.02');
  });

  it.each([
    [{ rungSize: '50' }, /minimum order/],
    [{ floorPrice: '0.2' }, /Floor/],
    [{ basePrice: '0.2' }, /Base price/],
    [{ stepPct: '50' }, /Step/],
    [{ rungSize: '300000' }, /Rung size/],
    [{ startZig: 'abc' }, /number/],
    [{ maxCycles: 0 }, /cycles/],
  ])('rejects %j', (bad, message) => {
    expect(() => build(bad as never)).toThrow(SimSettingsError);
    expect(() => build(bad as never)).toThrow(message);
  });
});
