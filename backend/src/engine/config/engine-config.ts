import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import * as YAML from 'yaml';
import Decimal from 'decimal.js';

export interface LadderConfig {
  name: string;
  offset: Decimal;
}

export interface PairConfig {
  pairId: string;
  venue: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  basePrice: Decimal;
  floorPrice: Decimal;
  topPrice: Decimal;
  step: Decimal;
  ladders: LadderConfig[];
  rungSizeBase: Decimal;
  maxBaseOwed: Decimal;
  dustToleranceBase: Decimal;
  dustToleranceQuote: Decimal;
  selfTuningBounds: {
    pegRequoteSeconds: [number, number];
    armedRungsMax: [number, number];
    restPollSeconds: [number, number];
  };
  /** Onboarding thresholds (defaults from the spec, set in config). */
  onboarding: { maxTickPctOfFloor: Decimal; maxRungPctOfHourlyVolume: Decimal; minOrderValueMultiple: Decimal };
}

export interface SharedConfig {
  maxQuoteOnVenueUsd: Record<string, Decimal | null>;
  maxLivePairsPerKey: number | null;
  weeklySweep: string;
  leaseTtlSeconds: number;
  heartbeatSeconds: number;
  invariantCheckSeconds: number;
  feedStaleSeconds: number;
}

export class ConfigError extends Error {}

const dec = (v: unknown, name: string): Decimal => {
  try {
    const d = new Decimal(String(v));
    if (!d.isFinite()) throw new Error('not finite');
    return d;
  } catch {
    throw new ConfigError(`${name} must be a number`);
  }
};

const need = <T>(raw: Record<string, any>, key: string): T => {
  if (raw[key] === undefined || raw[key] === null) throw new ConfigError(`missing ${key}`);
  return raw[key] as T;
};

function range(raw: any, name: string, hardMin: number): [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2 || raw.some((n) => typeof n !== 'number')) {
    throw new ConfigError(`self_tuning_bounds.${name} must be [min, max]`);
  }
  if (raw[0] < hardMin || raw[0] > raw[1]) throw new ConfigError(`self_tuning_bounds.${name} is invalid`);
  return [raw[0], raw[1]];
}

/** Parses and validates one pair file. The engine must refuse to start when this throws. */
export function parsePairConfig(text: string): PairConfig {
  const raw = YAML.parse(text) as Record<string, any>;
  if (!raw || typeof raw !== 'object') throw new ConfigError('pair config is empty');

  const ladders: LadderConfig[] = (need<any[]>(raw, 'ladders') ?? []).map((l, i) => ({
    name: String(l?.name ?? ''),
    offset: dec(l?.offset ?? 0, `ladders[${i}].offset`),
  }));
  if (!ladders.length) throw new ConfigError('at least one ladder is required');
  const names = new Set<string>();
  for (const l of ladders) {
    if (!/^[A-Za-z0-9]{1,4}$/.test(l.name)) throw new ConfigError(`ladder name "${l.name}" must be 1-4 alphanumerics`);
    if (names.has(l.name)) throw new ConfigError(`duplicate ladder ${l.name}`);
    names.add(l.name);
    if (l.offset.isNegative()) throw new ConfigError('ladder offsets cannot be negative');
  }

  const b = need<Record<string, any>>(raw, 'self_tuning_bounds');
  const ob = (raw.onboarding ?? {}) as Record<string, any>;
  const cfg: PairConfig = {
    pairId: String(need(raw, 'pair_id')),
    venue: String(need(raw, 'venue')),
    symbol: String(need(raw, 'symbol')),
    baseAsset: String(need(raw, 'base_asset')),
    quoteAsset: String(need(raw, 'quote_asset')),
    basePrice: dec(need(raw, 'base_price'), 'base_price'),
    floorPrice: dec(need(raw, 'floor_price'), 'floor_price'),
    topPrice: dec(need(raw, 'top_price'), 'top_price'),
    step: dec(need(raw, 'step'), 'step'),
    ladders,
    rungSizeBase: dec(need(raw, 'rung_size_base'), 'rung_size_base'),
    maxBaseOwed: dec(need(raw, 'max_base_owed'), 'max_base_owed'),
    dustToleranceBase: dec(need(raw, 'dust_tolerance_base'), 'dust_tolerance_base'),
    dustToleranceQuote: dec(need(raw, 'dust_tolerance_quote'), 'dust_tolerance_quote'),
    selfTuningBounds: {
      pegRequoteSeconds: range(b.peg_requote_seconds, 'peg_requote_seconds', 1),
      armedRungsMax: range(b.armed_rungs_max, 'armed_rungs_max', 1),
      restPollSeconds: range(b.rest_poll_seconds, 'rest_poll_seconds', 1),
    },
    onboarding: {
      maxTickPctOfFloor: dec(ob.max_tick_pct_of_floor ?? '0.1', 'onboarding.max_tick_pct_of_floor'),
      maxRungPctOfHourlyVolume: dec(ob.max_rung_pct_of_hourly_volume ?? '5', 'onboarding.max_rung_pct_of_hourly_volume'),
      minOrderValueMultiple: dec(ob.min_order_value_multiple ?? '2', 'onboarding.min_order_value_multiple'),
    },
  };

  if (!cfg.basePrice.isPositive()) throw new ConfigError('base_price must be positive');
  if (!(cfg.floorPrice.isPositive() && cfg.floorPrice.lt(cfg.topPrice))) throw new ConfigError('floor_price must be positive and below top_price');
  if (cfg.basePrice.lt(cfg.floorPrice) || cfg.basePrice.gt(cfg.topPrice)) throw new ConfigError('base_price must sit between floor and top');
  if (!(cfg.step.gt(0) && cfg.step.lt(1))) throw new ConfigError('step must be between 0 and 1 (e.g. 0.03)');
  if (!cfg.rungSizeBase.isPositive()) throw new ConfigError('rung_size_base must be positive');
  if (!cfg.maxBaseOwed.isPositive()) throw new ConfigError('max_base_owed must be positive');
  if (cfg.dustToleranceBase.isNegative() || cfg.dustToleranceQuote.isNegative()) throw new ConfigError('dust tolerances cannot be negative');
  if (!/^[A-Za-z0-9]+$/.test(cfg.symbol)) throw new ConfigError('symbol must be alphanumeric');
  return cfg;
}

export function parseSharedConfig(text: string): SharedConfig {
  const raw = YAML.parse(text) as Record<string, any>;
  const caps: Record<string, Decimal | null> = {};
  for (const [venue, v] of Object.entries((raw?.max_quote_on_venue_usd ?? {}) as Record<string, unknown>)) {
    caps[venue] = v === null || v === undefined ? null : dec(v, `max_quote_on_venue_usd.${venue}`);
  }
  const num = (key: string, fallback: number) => {
    const v = raw?.[key] ?? fallback;
    if (typeof v !== 'number' || v <= 0) throw new ConfigError(`${key} must be a positive number`);
    return v;
  };
  return {
    maxQuoteOnVenueUsd: caps,
    maxLivePairsPerKey: raw?.max_live_pairs_per_key ?? null,
    weeklySweep: String(raw?.weekly_sweep ?? 'MON 00:00 UTC'),
    leaseTtlSeconds: num('lease_ttl_seconds', 15),
    heartbeatSeconds: num('heartbeat_seconds', 10),
    invariantCheckSeconds: num('invariant_check_seconds', 60),
    feedStaleSeconds: num('feed_stale_seconds', 60),
  };
}

/**
 * Hash of the money settings. Any change to what is sold, at what price or how much changes the hash,
 * so an unapproved edit is caught by invariant I10. Self-tuning bounds and onboarding thresholds are
 * included on purpose: widening them is also a strategy change.
 */
export function configHash(cfg: PairConfig): string {
  const canonical = {
    pairId: cfg.pairId, venue: cfg.venue, symbol: cfg.symbol, baseAsset: cfg.baseAsset, quoteAsset: cfg.quoteAsset,
    basePrice: cfg.basePrice.toFixed(), floorPrice: cfg.floorPrice.toFixed(), topPrice: cfg.topPrice.toFixed(),
    step: cfg.step.toFixed(),
    ladders: cfg.ladders.map((l) => ({ name: l.name, offset: l.offset.toFixed() })),
    rungSizeBase: cfg.rungSizeBase.toFixed(), maxBaseOwed: cfg.maxBaseOwed.toFixed(),
    dustToleranceBase: cfg.dustToleranceBase.toFixed(), dustToleranceQuote: cfg.dustToleranceQuote.toFixed(),
    selfTuningBounds: cfg.selfTuningBounds,
    onboarding: {
      a: cfg.onboarding.maxTickPctOfFloor.toFixed(), b: cfg.onboarding.maxRungPctOfHourlyVolume.toFixed(),
      c: cfg.onboarding.minOrderValueMultiple.toFixed(),
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface Approval {
  hash: string;
  /** Two distinct humans must approve any money setting. */
  approvers: string[];
  approvedAt?: string;
}

export type ApprovalsFile = Record<string, Approval>;

export function loadApprovals(path: string): ApprovalsFile {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as ApprovalsFile;
}

/** Returns the reason the config is not approved for live trading, or null when it is. */
/** `key` is the engine scope (`<ownerId>/<pairId>`): each user approves their own configs. */
export function approvalProblem(cfg: PairConfig, approvals: ApprovalsFile, key = cfg.pairId): string | null {
  const entry = approvals[key];
  if (!entry) return 'no approval recorded for this pair';
  if (new Set(entry.approvers.map((a) => a.trim().toLowerCase()).filter(Boolean)).size < 2) {
    return 'money settings need two distinct approvers';
  }
  if (entry.hash !== configHash(cfg)) return 'config hash does not match the approved hash';
  return null;
}

export function loadPairConfig(path: string): PairConfig {
  return parsePairConfig(readFileSync(path, 'utf8'));
}

export function loadSharedConfig(path: string): SharedConfig {
  return parseSharedConfig(readFileSync(path, 'utf8'));
}
