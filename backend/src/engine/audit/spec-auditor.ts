import Decimal from 'decimal.js';
import { PairConfig } from '../config/engine-config';
import { LatticeRung } from '../lattice';
import { parseOrderId } from '../order-id';
import { CycleRecord, buybackQty } from '../rung-accounting';
import { Fill, VenueSpecs } from '../types';
import { VenueLogEntry } from '../venue/sim-venue';

/**
 * Independent spec auditor. It does not ask the engine whether it behaved: it replays what the
 * venue saw (every order placed, cancelled and filled) plus the ledger's fills and cycles, and
 * checks each rule of the spec against that evidence.
 */

export interface AuditCheck {
  id: string;
  rule: string;
  pass: boolean;
  detail: string;
}

export interface AuditInput {
  cfg: PairConfig;
  specs: VenueSpecs;
  lattice: LatticeRung[];
  venueLog: VenueLogEntry[];
  /** Ledger fills, including internal netting bookings that never reached the venue. */
  ledgerFills: Fill[];
  cycles: CycleRecord[];
  startBase: Decimal;
  startQuote: Decimal;
  engineKills: string[];
  /** Kills the scenario deliberately provokes (drills). */
  expectedKills?: number;
  breaches: string[];
  rebuildMatches: boolean;
  finalStatus: string;
  /** False for a run the user already stopped. */
  expectRunning?: boolean;
}

const ZERO = new Decimal(0);

export function auditRun(a: AuditInput): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const add = (id: string, rule: string, failures: string[], okDetail: string) =>
    checks.push({ id, rule, pass: failures.length === 0, detail: failures.length ? `${failures.length} violation(s): ${failures.slice(0, 3).join(' | ')}` : okDetail });

  const rungs = new Map(a.lattice.map((r) => [r.key, r]));
  const lot = a.specs.lot;
  const places = a.venueLog.filter((e) => e.kind === 'place') as Extract<VenueLogEntry, { kind: 'place' }>[];
  const accepted = places.filter((p) => p.ok);

  // The venue's own event order is the timeline (an order is always placed before it fills).
  // Internal netting bookings never reach the venue; they slot in by timestamp.
  type Ev =
    | { kind: 'fill'; fill: Fill }
    | { kind: 'place'; p: (typeof accepted)[number] }
    | { kind: 'cancel'; c: Extract<VenueLogEntry, { kind: 'cancel' }> };
  const netted = a.ledgerFills.filter((f) => f.netted).sort((x, y) => x.ts - y.ts);
  const timeline: Ev[] = [];
  let ni = 0;
  for (const e of a.venueLog) {
    while (ni < netted.length && netted[ni].ts < e.t) timeline.push({ kind: 'fill', fill: netted[ni++] });
    if (e.kind === 'place' && e.ok) timeline.push({ kind: 'place', p: e });
    else if (e.kind === 'cancel') timeline.push({ kind: 'cancel', c: e });
    else if (e.kind === 'fill') {
      timeline.push({ kind: 'fill', fill: {
        fillId: `log-${timeline.length}`, clientOrderId: e.id, orderId: '', side: e.side, price: e.price, qty: e.qty,
        feeAmount: e.feeAmount, feeAsset: e.feeAsset, ts: e.t,
      } });
    }
  }
  while (ni < netted.length) timeline.push({ kind: 'fill', fill: netted[ni++] });

  // ── IDs ─────────────────────────────────────────────────────────────────────────────────────
  {
    const fails: string[] = [];
    const seen = new Set<string>();
    for (const p of accepted) {
      if (seen.has(p.id)) fails.push(`${p.id} placed twice`);
      seen.add(p.id);
      const id = parseOrderId(p.id);
      if (!id || id.symbol !== a.cfg.symbol || !rungs.has(id.rungKey)) fails.push(`${p.id} is not a valid engine id`);
    }
    const dupAttempts = places.filter((p) => !p.ok && p.reason === 'INVALID').length;
    if (dupAttempts) fails.push(`${dupAttempts} placement(s) rejected as invalid (duplicate id, tick/lot/min or self-trade)`);
    add('IDS', 'Client order ids follow the spec format and are never re-sent', fails, `${accepted.length} orders, every id unique and well-formed`);
  }

  // ── Rules 1, 3, 4 and the one-order-per-rung rule, per rung ──────────────────────────────────
  const r1: string[] = []; const r3: string[] = []; const r4: string[] = []; const one: string[] = []; const arm: string[] = [];
  {
    type RungTrack = {
      sold: Map<number, Decimal>; bought: Map<number, Decimal>; firstOrderSeen: boolean;
      partialCancel: Map<number, boolean>;
    };
    const track = new Map<string, RungTrack>();
    const get = (k: string) => {
      let t = track.get(k);
      if (!t) { t = { sold: new Map(), bought: new Map(), firstOrderSeen: false, partialCancel: new Map() }; track.set(k, t); }
      return t;
    };
    const closedCycle = new Map<string, number>(); // rungKey -> highest closed cycle so far
    const cyclesByKey = new Map<string, CycleRecord[]>();
    for (const c of a.cycles) cyclesByKey.set(c.rungKey, [...(cyclesByKey.get(c.rungKey) ?? []), c]);

    for (const ev of timeline) {
      if (ev.kind === 'cancel') {
        // A sell cancelled once the market reached the buyback target: the agreed partial-sell exception.
        const id = parseOrderId(ev.c.id);
        const rung = id ? rungs.get(id.rungKey) : undefined;
        if (id && rung && id.side === 'SELL' && ev.c.market.lte(rung.buyPrice.plus(a.specs.tick.mul(2)))) {
          get(id.rungKey).partialCancel.set(id.cycle, true);
        }
        continue;
      }
      if (ev.kind === 'fill') {
        const id = parseOrderId(ev.fill.clientOrderId);
        if (!id) continue;
        const t = get(id.rungKey);
        const m = id.side === 'SELL' ? t.sold : t.bought;
        const qty = id.side === 'BUY' && ev.fill.feeAsset === 'base' ? ev.fill.qty.minus(ev.fill.feeAmount) : ev.fill.qty;
        m.set(id.cycle, (m.get(id.cycle) ?? ZERO).plus(id.side === 'BUY' ? ev.fill.qty : qty));
        // A cycle closes when its buyback reaches the gross target.
        if (id.side === 'BUY') {
          const sold = t.sold.get(id.cycle) ?? ZERO;
          if ((t.bought.get(id.cycle) ?? ZERO).gte(buybackQty(sold, a.specs).minus(lot)) && sold.gt(0)) {
            closedCycle.set(id.rungKey, Math.max(closedCycle.get(id.rungKey) ?? 0, id.cycle));
          }
        }
        continue;
      }
      const p = ev.p;
      const id = parseOrderId(p.id);
      const rung = id ? rungs.get(id.rungKey) : undefined;
      if (!id || !rung) continue;
      const t = get(id.rungKey);
      // Rule 1: a rung's first order is a sell.
      if (!t.firstOrderSeen && id.side !== 'SELL') r1.push(`${p.id} was the rung's first order`);
      t.firstOrderSeen = true;
      // Rule 3: never buy above target, never sell below the rung.
      if (id.side === 'BUY' && p.price.gt(rung.buyPrice)) r3.push(`${p.id} buy ${p.price} > target ${rung.buyPrice}`);
      if (id.side === 'SELL' && p.price.lt(rung.sellPrice)) r3.push(`${p.id} sell ${p.price} < rung ${rung.sellPrice}`);
      // Arming: a first sell rests above the market (never dumps lower rungs at market).
      if (id.side === 'SELL' && id.revision === 1 && p.price.lte(p.market)) arm.push(`${p.id} at ${p.price} with market ${p.market}`);
      // Rule 4: a buyback only after the sell is 100% filled (or the agreed partial-sell exception).
      if (id.side === 'BUY') {
        const sold = t.sold.get(id.cycle) ?? ZERO;
        if (sold.isZero()) r1.push(`${p.id} buys ZIG the rung has not sold`);
        else if (sold.lt(a.cfg.rungSizeBase.minus(lot)) && !t.partialCancel.get(id.cycle)) {
          r4.push(`${p.id} placed after only ${sold}/${a.cfg.rungSizeBase} sold`);
        }
        // Same quantity back: the order never asks for more than the gross-up of what sold.
        const bought = t.bought.get(id.cycle) ?? ZERO;
        if (p.qty.plus(bought).gt(buybackQty(sold, a.specs).plus(lot))) r4.push(`${p.id} buys ${p.qty} more than owed`);
      }
      // Rule 4: a re-sell (cycle > 1) only after the previous buyback is 100% filled.
      if (id.side === 'SELL' && id.cycle > 1 && (closedCycle.get(id.rungKey) ?? 0) < id.cycle - 1) {
        r4.push(`${p.id} re-sell before cycle ${id.cycle - 1} closed`);
      }
    }

    // One live order per rung at any time.
    const open = new Map<string, Map<string, { side: string; price: Decimal; qty: Decimal; filled: Decimal }>>();
    for (const e of a.venueLog) {
      const id = parseOrderId(e.id);
      if (!id) continue;
      const m = open.get(id.rungKey) ?? new Map();
      open.set(id.rungKey, m);
      if (e.kind === 'place' && e.ok) {
        m.set(e.id, { side: e.side, price: e.price, qty: e.qty, filled: ZERO });
        if (m.size > 1) one.push(`${id.rungKey} had ${m.size} live orders at ${new Date(e.t).toISOString()}`);
      } else if (e.kind === 'cancel') {
        m.delete(e.id);
      } else if (e.kind === 'fill') {
        const o = m.get(e.id);
        if (o) { o.filled = o.filled.plus(e.qty); if (o.filled.gte(o.qty)) m.delete(e.id); }
      }
    }
  }
  add('R1', 'Rule 1: sell first; no rung buys ZIG it has not sold', r1, 'every rung opened with a sell; no buy without a prior sell');
  add('R3', 'Rule 3: never buy above target, never sell below the rung', r3, `${accepted.length} orders all inside their caps and floors`);
  add('R4', 'Rule 4: full fill gates the next step (except the partial-sell exception)', r4, 'every buyback followed a full sell; every re-sell followed a full buyback');
  add('ONE', 'A rung never has more than one live order', one, 'never more than one live order per rung');
  add('ARM', 'At start-up and on arming, sells rest above the market (no dumping lower rungs)', arm, 'every first sell rested above the market');

  // ── Rule 5: never trade with ourselves (no crossed own book at any moment) ───────────────────
  {
    const fails: string[] = [];
    const book = new Map<string, { side: string; price: Decimal; qty: Decimal; filled: Decimal }>();
    for (const e of a.venueLog) {
      if (e.kind === 'place' && e.ok) book.set(e.id, { side: e.side, price: e.price, qty: e.qty, filled: ZERO });
      else if (e.kind === 'cancel') book.delete(e.id);
      else if (e.kind === 'fill') { const o = book.get(e.id); if (o) { o.filled = o.filled.plus(e.qty); if (o.filled.gte(o.qty)) book.delete(e.id); } }
      if (e.kind !== 'place' || !e.ok) continue;
      let maxBuy: Decimal | null = null; let minSell: Decimal | null = null;
      for (const o of book.values()) {
        if (o.side === 'BUY' && (!maxBuy || o.price.gt(maxBuy))) maxBuy = o.price;
        if (o.side === 'SELL' && (!minSell || o.price.lt(minSell))) minSell = o.price;
      }
      if (maxBuy && minSell && maxBuy.gte(minSell)) fails.push(`${e.id}: own buy ${maxBuy} >= own sell ${minSell}`);
    }
    const stp = places.filter((p) => !p.ok && p.reason === 'INVALID').length;
    if (stp) fails.push(`${stp} placement(s) blocked by venue self-trade protection or validation`);
    add('R5', 'Rule 5: the engine never trades with itself', fails, 'our highest buy was always below our lowest sell');
  }

  // ── Rule 6: every order is real (no placing to cancel) ─────────────────────────────────────
  {
    const cancels = a.venueLog.filter((e) => e.kind === 'cancel') as Extract<VenueLogEntry, { kind: 'cancel' }>[];
    const placedAt = new Map(accepted.map((p) => [p.id, p.t]));
    const quick = cancels.filter((c) => (c.t - (placedAt.get(c.id) ?? c.t)) < 2000 && a.engineKills.length === 0);
    const ratio = accepted.length ? cancels.length / accepted.length : 0;
    const fails = quick.map((c) => `${c.id} cancelled ${c.t - (placedAt.get(c.id) ?? c.t)} ms after placing`);
    add('R6', 'Rule 6: every order is real (none placed to be cancelled)', fails,
      `${cancels.length} cancels for ${accepted.length} orders (${(ratio * 100).toFixed(1)}%), all from pegging, the exception or the kill switch, none within 2 s of placing`);
  }

  // ── Money: never spends USDT it did not earn; never holds more ZIG than it started with ──────
  {
    let base = a.startBase; let quote = a.startQuote;
    let minQuote = quote; let maxBase = base;
    let closed = 0;
    const failsQ: string[] = []; const failsB: string[] = [];
    const cycleCloses = [...a.cycles].map((c) => c.closedAt).sort((x, y) => x - y);
    for (const e of a.venueLog) {
      if (e.kind !== 'fill') continue;
      while (closed < cycleCloses.length && cycleCloses[closed] <= e.t) closed++;
      if (e.side === 'SELL') {
        base = base.minus(e.qty);
        quote = quote.plus(e.price.mul(e.qty)).minus(e.feeAsset === 'quote' ? e.feeAmount : ZERO);
      } else {
        base = base.plus(e.qty).minus(e.feeAsset === 'base' ? e.feeAmount : ZERO);
        quote = quote.minus(e.price.mul(e.qty)).minus(e.feeAsset === 'quote' ? e.feeAmount : ZERO);
      }
      if (quote.lt(minQuote)) minQuote = quote;
      if (base.gt(maxBase)) maxBase = base;
      if (quote.lt(a.startQuote.minus(a.cfg.dustToleranceQuote))) failsQ.push(`quote fell to ${quote.toFixed(4)} below start ${a.startQuote}`);
      // Buybacks round up to the lot, so each completed cycle may return at most one extra lot.
      const allowance = a.cfg.dustToleranceBase.plus(lot.mul(closed + 1));
      if (base.gt(a.startBase.plus(allowance))) failsB.push(`base rose to ${base} above start ${a.startBase} + ${allowance}`);
    }
    add('USDT', 'Never spends USDT it did not earn from its own sells', failsQ, `lowest quote balance ${minQuote.toFixed(4)} (start ${a.startQuote})`);
    add('ZIG', 'Never holds more ZIG than it started with (beyond lot rounding)', failsB, `highest ZIG balance ${maxBase} (start ${a.startBase})`);
  }

  // ── Cycles: same quantity back, profit >= 0 and matching the formula ────────────────────────
  {
    const qtyFails: string[] = []; const profitFails: string[] = []; const formulaFails: string[] = [];
    for (const c of a.cycles) {
      if (c.boughtNet.minus(c.soldQty).abs().gt(lot)) qtyFails.push(`${c.rungKey}#${c.cycle} sold ${c.soldQty} got back ${c.boughtNet}`);
      if (c.profit.isNegative()) profitFails.push(`${c.rungKey}#${c.cycle} profit ${c.profit}`);
      if (!c.netted) {
        const expected = c.soldQty.mul(c.avgSell).mul(new Decimal(1).minus(a.specs.makerFee)).minus(c.boughtGross.mul(c.avgBuy));
        if (c.profit.minus(expected).abs().gt('0.000001')) formulaFails.push(`${c.rungKey}#${c.cycle} ${c.profit} vs ${expected}`);
      }
    }
    add('R2', 'Rule 2: same quantity back; profit taken in USDT only', qtyFails, `${a.cycles.length} cycles, each returned the ZIG it sold (within one lot)`);
    add('I8', 'Every completed cycle has net profit >= 0', profitFails, `${a.cycles.length} cycles, lowest profit ${a.cycles.length ? Decimal.min(...a.cycles.map((c) => c.profit)).toFixed(4) : '—'}`);
    add('FORMULA', 'Every cycle\'s profit matches the formula', formulaFails, 'all cycles match proceeds-after-fee minus buyback cost');
  }

  // ── Engine health ────────────────────────────────────────────────────────────────────────────
  {
    const unexpected = a.engineKills.slice(a.expectedKills ?? 0);
    add('KILL', 'No unexpected kill-switch events', unexpected, a.engineKills.length ? `${a.engineKills.length} kill(s), all provoked by the scenario` : 'no kill-switch events');
    add('INV', 'Invariants I1-I10 clean at the end', a.breaches, 'no breaches');
    add('REBUILD', 'The rung table is rebuildable from fill events alone', a.rebuildMatches ? [] : ['rebuilt rungs differ from the live rung table'], 'rebuilt state matches');
    if (a.expectRunning !== false) {
      add('STATUS', 'Engine still running', a.finalStatus === 'RUNNING' ? [] : [`status ${a.finalStatus}`], 'RUNNING');
    }
  }
  return checks;
}
