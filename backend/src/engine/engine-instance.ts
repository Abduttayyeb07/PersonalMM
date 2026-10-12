import Decimal from 'decimal.js';
import { PairConfig, SharedConfig, configHash } from './config/engine-config';
import { checkInvariants, reserveOf, profitOf, Breach } from './invariants';
import { LatticeRung, buildLattice } from './lattice';
import { Ledger } from './ledger/ledger';
import { buildOrderId, parseOrderId } from './order-id';
import { GateResult, RiskGate } from './risk/risk-gate';
import {
  CycleRecord, RungRecord, applyFill, armSell, cloneRung, newRung, owed, remaining, startBuyLeg,
} from './rung-accounting';
import { Lease } from './supervisor/lease';
import { Alerter, Book, Clock, Fill, Logger, OrderUpdate, Side, VenueSpecs } from './types';
import { VenueAdapter } from './venue/venue';

export function scopeId(ownerId: string, pairId: string): string {
  if (!ownerId || ownerId.includes('/')) throw new Error('ownerId is required and may not contain "/"');
  return `${ownerId}/${pairId}`;
}

export type EngineStatus = 'STOPPED' | 'PAUSED' | 'RUNNING' | 'KILLED';
export type EngineMode = 'sim' | 'paper' | 'live';

export interface EngineDeps {
  /** The user who owns this engine. Every ledger row, lease and kill switch is scoped to them. */
  ownerId: string;
  cfg: PairConfig;
  shared: SharedConfig;
  specs: VenueSpecs;
  venue: VenueAdapter;
  ledger: Ledger;
  lease: Lease;
  alert: Alerter;
  clock: Clock;
  log: Logger;
  /** Identity of this process for the lease (host + pid). */
  holder: string;
  mode: EngineMode;
  /** Returns the approved config hash (I10). Only enforced in live mode. */
  approvedHash: () => string | null;
  /** Delay before re-checking a balance invariant, so a fill/balance race is not a false kill. */
  recheckDelayMs?: number;
}

export interface Tuning {
  pegRequoteMs: number;
  armedRungs: number;
  restPollMs: number;
}

export interface EngineSnapshot {
  pairId: string;
  status: EngineStatus;
  statusReason?: string;
  epoch: number | null;
  book: { bestBid: string; bestAsk: string } | null;
  rungsByState: Record<string, number>;
  baseOwed: string;
  reserve: string;
  profitSinceSweep: string;
  cyclesCompleted: number;
  liveOrders: number;
  lastInvariantCheck: number | null;
  lastBreaches: Breach[];
}

const ZERO = new Decimal(0);
const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));

/**
 * One running copy of the trading logic for one pair. It holds no state that is not also in the
 * ledger: every transition is persisted before (or atomically with) its side effect.
 */
export class EngineInstance {
  readonly lattice: LatticeRung[];
  readonly tuning: Tuning;
  private readonly rungs = new Map<string, RungRecord>();
  private readonly gate: RiskGate;
  private readonly runningHash: string;
  private status: EngineStatus = 'STOPPED';
  private statusReason?: string;
  private epoch: number | null = null;
  private book: Book | null = null;
  private lastMarketTs = 0;
  private privateFeedDownSince: number | null = null;
  private marketFeedDownSince: number | null = null;
  private cycles: CycleRecord[] = [];
  private sweeps = ZERO;
  private profitBalance = ZERO;
  private lastInvariantCheck: number | null = null;
  private lastBreaches: Breach[] = [];
  private pollStrikes = 0;
  /** Set when missed fills were applied mid-pass; the current drive restarts from fresh state. */
  private stateResynced = false;
  /** Set when a kill was caused by a lost feed: the engine restarts by itself once feeds are back. */
  private autoRecover = false;
  private rateLimitedUntil = 0;
  private rateLimitBackoffMs = 1000;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: EngineDeps) {
    this.lattice = buildLattice(d.cfg, d.specs);
    this.runningHash = configHash(d.cfg);
    const b = d.cfg.selfTuningBounds;
    this.tuning = {
      pegRequoteMs: clamp(5, b.pegRequoteSeconds) * 1000,
      armedRungs: Math.min(clamp(b.armedRungsMax[1], b.armedRungsMax), d.specs.maxOpenOrders),
      restPollMs: clamp(30, b.restPollSeconds) * 1000,
    };
    this.gate = new RiskGate(d.cfg, d.shared, d.specs, d.lease, d.holder, d.venue.name, scopeId(d.ownerId, d.cfg.pairId));
  }

  // ── Public surface ───────────────────────────────────────────────────────────────────────────

  /** Scope id `<ownerId>/<pairId>`: users never share ledger rows, leases or kill switches. */
  get pairId() { return scopeId(this.d.ownerId, this.d.cfg.pairId); }
  getStatus() { return this.status; }
  getEpoch() { return this.epoch; }
  getRungs(): RungRecord[] { return [...this.rungs.values()].map(cloneRung); }
  getCycles(): CycleRecord[] { return [...this.cycles]; }

  /** Serialises every handler: events are processed one at a time, in arrival order. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every queued event has been processed. */
  idle(): Promise<void> { return this.enqueue(async () => undefined); }

  onBook(book: Book) { return this.enqueue(() => this.handleBook(book)); }
  onFill(fill: Fill) { return this.enqueue(() => this.handleFill(fill)); }
  onOrderUpdate(update: OrderUpdate) { return this.enqueue(() => this.handleOrderUpdate(update)); }
  onFeedStatus(feed: 'market' | 'private', connected: boolean) {
    return this.enqueue(async () => {
      const now = this.d.clock.now();
      if (feed === 'market') this.marketFeedDownSince = connected ? null : (this.marketFeedDownSince ?? now);
      else this.privateFeedDownSince = connected ? null : (this.privateFeedDownSince ?? now);
    });
  }
  /** Periodic work: staleness, pegging, retries, arming. Call about once a second. */
  tick() { return this.enqueue(() => this.handleTick()); }
  /** REST cross-check of fills and open orders (spec: every 30 s). */
  poll() { return this.enqueue(() => this.handlePoll()); }
  checkNow(context = 'scheduled') { return this.enqueue(() => this.runInvariants(context)); }
  manualKill(by: string) { return this.enqueue(() => this.kill(`manual stop by ${by}`)); }

  /** Lease renewal. If it fails we stop sending orders immediately: someone else may own the pair. */
  async renewLease(): Promise<boolean> {
    if (this.epoch === null || this.status === 'STOPPED') return false;
    const ok = await this.d.lease.renew(this.pairId, this.d.holder, this.epoch, this.d.shared.leaseTtlSeconds * 1000);
    if (!ok) {
      await this.enqueue(async () => {
        this.status = 'STOPPED';
        this.statusReason = 'lease lost';
        this.d.log.error(`[${this.pairId}] lease lost; this instance stops trading`);
        await this.d.ledger.audit(this.pairId, 'LEASE_LOST', { holder: this.d.holder, epoch: this.epoch });
        await this.d.alert.send(`⚠️ ${this.pairId}: lease lost by ${this.d.holder}; this instance stopped`);
      });
    }
    return ok;
  }

  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.epoch !== null) await this.d.lease.release(this.pairId, this.d.holder, this.epoch);
      this.status = 'STOPPED';
    });
  }

  /** Records base and quote at start. Only done once per pair; I1 and I3 are measured against it. */
  async initGenesis(): Promise<void> {
    if (await this.d.ledger.getGenesis(this.pairId)) return;
    const b = await this.d.venue.getBalances();
    await this.d.ledger.setGenesis(this.pairId, { baseAtStart: b.base, quoteAtStart: b.quote, createdAt: this.d.clock.now() });
    await this.d.ledger.audit(this.pairId, 'GENESIS', { base: b.base.toFixed(), quote: b.quote.toFixed() });
  }

  /**
   * Restart procedure: start PAUSED, replay what happened on the venue, reconcile, and only then
   * resume. Safe to call after a crash at any point.
   */
  start(): Promise<EngineStatus> {
    return this.enqueue(async () => {
      const epoch = await this.d.lease.acquire(this.pairId, this.d.holder, this.d.shared.leaseTtlSeconds * 1000);
      if (epoch === null) {
        this.status = 'STOPPED';
        this.statusReason = 'another instance holds the lease';
        return this.status;
      }
      this.epoch = epoch;
      this.status = 'PAUSED';
      this.statusReason = 'restarting';
      await this.d.ledger.audit(this.pairId, 'LEASE_ACQUIRED', { holder: this.d.holder, epoch });
      return this.restartProcedure();
    });
  }

  /** Human-approved resume after a kill or pause. Goes through the full restart procedure. */
  resume(by: string): Promise<EngineStatus> {
    return this.enqueue(async () => {
      await this.d.ledger.setKilled(this.pairId, false, by);
      await this.d.ledger.audit(this.pairId, 'RESUME', { by }, by);
      if (this.epoch === null) return this.status;
      this.status = 'PAUSED';
      return this.restartProcedure();
    });
  }

  /** Self-healing: a PAUSED pair (venue outage, failed reconciliation) retries the restart procedure. */
  recover(): Promise<EngineStatus> {
    return this.enqueue(async () => {
      if (this.epoch === null) return this.status;
      if (this.status === 'KILLED' && this.autoRecover && this.feedsHealthy()) {
        await this.d.ledger.audit(this.pairId, 'AUTO_RECOVER', { after: this.statusReason });
        this.status = 'PAUSED';
        this.autoRecover = false;
        return this.restartProcedure();
      }
      if (this.status !== 'PAUSED') return this.status;
      return this.restartProcedure();
    });
  }

  /** Market data is flowing and neither feed is marked down. */
  private feedsHealthy(): boolean {
    const staleMs = this.d.shared.feedStaleSeconds * 1000;
    return this.d.clock.now() - this.lastMarketTs <= staleMs && this.marketFeedDownSince === null && this.privateFeedDownSince === null;
  }

  snapshot(): EngineSnapshot {
    const rungs = [...this.rungs.values()];
    const byState: Record<string, number> = { IDLE: 0, SELL_LIVE: 0, BUY_LIVE: 0 };
    for (const r of rungs) byState[r.state] += 1;
    return {
      pairId: this.pairId,
      status: this.status,
      statusReason: this.statusReason,
      epoch: this.epoch,
      book: this.book ? { bestBid: this.book.bestBid.toFixed(), bestAsk: this.book.bestAsk.toFixed() } : null,
      rungsByState: byState,
      baseOwed: rungs.reduce((s, r) => s.plus(owed(r)), ZERO).toFixed(),
      reserve: reserveOf(rungs).toFixed(),
      profitSinceSweep: profitOf(this.cycles, this.sweeps).toFixed(),
      cyclesCompleted: this.cycles.length,
      liveOrders: rungs.filter((r) => r.order).length,
      lastInvariantCheck: this.lastInvariantCheck,
      lastBreaches: this.lastBreaches,
    };
  }

  // ── Restart procedure ────────────────────────────────────────────────────────────────────────

  private async restartProcedure(): Promise<EngineStatus> {
    const { ledger, venue, cfg } = this.d;

    if (await ledger.isKilled(this.pairId)) {
      this.status = 'KILLED';
      this.statusReason = 'kill switch is set; a human must resume';
      return this.status;
    }
    if (!(await ledger.getGenesis(this.pairId))) {
      this.status = 'PAUSED';
      this.statusReason = 'no genesis recorded; run init first';
      return this.status;
    }

    // Load rung state; add rungs that a config change introduced. Existing open cycles keep the
    // targets they were opened with; an IDLE rung takes the new lattice prices.
    const stored = new Map((await ledger.loadRungs(this.pairId)).map((r) => [r.key, r]));
    this.rungs.clear();
    const changed: RungRecord[] = [];
    for (const l of this.lattice) {
      const existing = stored.get(l.key);
      if (!existing) {
        const fresh = newRung(l, cfg);
        this.rungs.set(l.key, fresh);
        changed.push(fresh);
      } else if (existing.state === 'IDLE' && (!existing.sellPrice.eq(l.sellPrice) || !existing.buyPrice.eq(l.buyPrice))) {
        const repriced = { ...existing, sellPrice: l.sellPrice, buyPrice: l.buyPrice };
        this.rungs.set(l.key, repriced);
        changed.push(repriced);
      } else {
        this.rungs.set(l.key, existing);
      }
      stored.delete(l.key);
    }
    for (const leftover of stored.values()) {
      if (leftover.state !== 'IDLE') this.rungs.set(leftover.key, leftover); // finish its cycle first
    }
    if (changed.length) await ledger.saveRungs(this.pairId, changed);

    this.cycles = await ledger.listCycles(this.pairId);
    this.sweeps = await ledger.sumSweeps(this.pairId);
    this.profitBalance = profitOf(this.cycles, this.sweeps);

    // Replay fills we may have missed while down.
    const known = await ledger.listFills(this.pairId);
    const since = known.reduce((m, f) => Math.max(m, f.ts), 0) - 60 * 60 * 1000;
    const missed = (await venue.getFillsSince(Math.max(0, since))).sort((a, b) => a.ts - b.ts);
    for (const f of missed) {
      await this.applyFillEvent(f, false);
      if (this.status === 'KILLED') return this.status;
    }

    // Reconcile every order we believe exists with what the venue reports.
    const open = await venue.getOpenOrders();
    const openIds = new Set(open.map((o) => o.clientOrderId));
    const ours = new Set<string>();
    for (const r of this.rungs.values()) {
      if (!r.order) continue;
      ours.add(r.order.clientOrderId);
      if (openIds.has(r.order.clientOrderId)) {
        if (r.order.status === 'INTENT') r.order.status = 'LIVE';
        if (r.order.status === 'CANCELING') await venue.cancelOrder(r.order.clientOrderId);
        continue;
      }
      // Not resting. Ask the venue directly before deciding: never place an order twice.
      const found = await venue.findOrder(r.order.clientOrderId);
      if (found.found && !found.cancelled && found.open) continue;
      // Gone (never arrived, cancelled, or fully filled and already replayed above).
      r.order = null;
      r.waiting = undefined;
    }
    for (const o of open) {
      if (!ours.has(o.clientOrderId)) {
        await this.kill(`order ${o.clientOrderId} on the venue was not issued by this engine`);
        return this.status;
      }
    }
    await ledger.saveRungs(this.pairId, [...this.rungs.values()]);

    // Reconcile balances. Any mismatch beyond dust keeps the pair paused.
    const breaches = await this.collectBreaches();
    if (breaches.length) {
      this.status = 'PAUSED';
      this.statusReason = `reconciliation failed: ${breaches.map((b) => b.id).join(', ')}`;
      this.lastBreaches = breaches;
      await ledger.audit(this.pairId, 'RESTART_BLOCKED', { breaches });
      await this.d.alert.send(`⛔ ${this.pairId}: restart blocked by ${breaches.map((b) => `${b.id} (${b.left} vs ${b.right})`).join('; ')}`);
      return this.status;
    }

    this.status = 'RUNNING';
    this.statusReason = undefined;
    await ledger.audit(this.pairId, 'RUNNING', { epoch: this.epoch });
    this.book = await venue.getBook().catch(() => null);
    if (this.book) this.lastMarketTs = this.d.clock.now();
    await this.drive();
    return this.status;
  }

  // ── Event handlers (always run inside the queue) ─────────────────────────────────────────────

  private async handleBook(book: Book) {
    this.book = book;
    this.lastMarketTs = this.d.clock.now();
    if (this.status !== 'RUNNING') return;
    await this.drive();
  }

  private async handleTick() {
    const now = this.d.clock.now();
    if (this.status !== 'RUNNING') return;

    if (await this.d.ledger.isKilled(this.pairId)) return this.kill('kill switch set in the control table');

    const staleMs = this.d.shared.feedStaleSeconds * 1000;
    if (now - this.lastMarketTs > staleMs) return this.kill('market data feed stale', true);
    if (this.privateFeedDownSince !== null && now - this.privateFeedDownSince > staleMs) return this.kill('private feed stale', true);
    if (this.marketFeedDownSince !== null && now - this.marketFeedDownSince > staleMs) return this.kill('market feed disconnected', true);

    await this.resolveIntents();
    await this.requote();
    await this.drive();
  }

  private async handlePoll() {
    if (this.status !== 'RUNNING') return;
    await this.syncMissedFills();
    if (this.status !== 'RUNNING') return;
    await this.runInvariants('poll');
    if (this.status === 'RUNNING') await this.drive();
  }

  /**
   * Applies fills the venue has that the ledger does not (missed by the private feed). All of them
   * are applied before anything is checked: balances on the venue already include every fill.
   */
  private async syncMissedFills(): Promise<number> {
    const lastTs = (await this.d.ledger.listFills(this.pairId)).reduce((m, f) => Math.max(m, f.ts), 0);
    let applied = 0;
    for (const f of (await this.d.venue.getFillsSince(Math.max(0, lastTs - 5 * 60 * 1000))).sort((a, b) => a.ts - b.ts)) {
      if (await this.d.ledger.hasFill(this.pairId, f.fillId)) continue;
      await this.applyFillEvent(f, false);
      applied += 1;
      if (this.status === 'KILLED') break;
    }
    return applied;
  }

  private async handleFill(fill: Fill) {
    await this.applyFillEvent(fill, true);
  }

  private async applyFillEvent(fill: Fill, drive: boolean) {
    const { ledger, cfg, specs } = this.d;
    if (this.status === 'KILLED') return;
    if (await ledger.hasFill(this.pairId, fill.fillId)) return;

    const id = parseOrderId(fill.clientOrderId);
    if (!id || id.symbol !== cfg.symbol) return this.kill(`fill ${fill.fillId} has a client id we did not issue (${fill.clientOrderId})`);
    const rung = this.rungs.get(id.rungKey);
    if (!rung) return this.kill(`fill ${fill.fillId} names unknown rung ${id.rungKey}`);
    if (id.cycle !== rung.cycle) return this.kill(`fill ${fill.fillId} is for cycle ${id.cycle} but rung ${rung.key} is on ${rung.cycle}`);
    const expectedSide: Side | null = rung.state === 'SELL_LIVE' ? 'SELL' : rung.state === 'BUY_LIVE' ? 'BUY' : null;
    if (fill.side !== expectedSide) return this.kill(`fill ${fill.fillId} side ${fill.side} does not match rung ${rung.key} in ${rung.state}`);

    let result;
    try {
      result = applyFill(rung, fill, cfg, specs);
    } catch (e) {
      return this.kill(`could not apply fill ${fill.fillId}: ${(e as Error).message}`);
    }
    const next = result.rung;
    if (result.outcome === 'PARTIAL' && rung.order) {
      next.order = { ...rung.order };
      if (next.order.clientOrderId === fill.clientOrderId) next.order.filled = next.order.filled.plus(fill.qty);
    }
    if (result.outcome !== 'PARTIAL') next.order = null; // leg finished: the order is fully filled
    if (result.outcome === 'CYCLE_CLOSED') this.adoptLattice(next);

    const applied = await ledger.commit(this.pairId, { fills: [fill], rungs: [next], cycle: result.cycle });
    if (!applied) return;
    this.rungs.set(next.key, next);

    if (result.cycle) {
      this.cycles.push(result.cycle);
      this.profitBalance = this.profitBalance.plus(result.cycle.profit);
      if (result.cycle.profit.isNegative()) {
        return this.kill(`cycle ${result.cycle.rungKey}#${result.cycle.cycle} closed with negative profit ${result.cycle.profit.toFixed()}`);
      }
    }

    // A cancel acknowledgement may have been waiting for this fill.
    if (next.order?.ackedFilled && next.order.filled.gte(next.order.ackedFilled)) {
      await this.afterCancel(next, next.order.ackedFilled);
    }

    if (drive && this.status === 'RUNNING') {
      await this.runInvariants('fill');
      if (this.status === 'RUNNING') await this.drive();
    }
  }

  private async handleOrderUpdate(u: OrderUpdate) {
    await this.processOrderUpdate(u);
    if (this.status === 'RUNNING') await this.drive();
  }

  private async processOrderUpdate(u: OrderUpdate) {
    const rung = [...this.rungs.values()].find((r) => r.order?.clientOrderId === u.clientOrderId);
    if (!rung || !rung.order) return; // an older revision, already handled
    if (u.status === 'REJECTED') {
      rung.order = null;
      await this.d.ledger.saveRungs(this.pairId, [rung]);
      return;
    }
    // Cancelled: wait until our fills for this order have caught up with what the venue reports.
    if (rung.order.filled.lt(u.filledQty)) {
      rung.order.ackedFilled = u.filledQty;
      await this.d.ledger.saveRungs(this.pairId, [rung]);
      return;
    }
    await this.afterCancel(rung, u.filledQty);
  }

  /** What to do once a cancel is confirmed and every fill of that order has been applied. */
  private async afterCancel(rung: RungRecord, filledOnOrder: Decimal) {
    const order = rung.order;
    if (!order) return;
    const pending = order.pending;
    rung.order = null;
    rung.waiting = undefined;

    if (this.status === 'KILLED') {
      await this.d.ledger.saveRungs(this.pairId, [rung]);
      return;
    }

    if (pending === 'NET') {
      const partner = order.netWith ? this.rungs.get(order.netWith) : undefined;
      if (filledOnOrder.isZero() && partner && !partner.order && partner.waiting === 'netting') {
        await this.bookNetting(rung, partner, order.price);
        return;
      }
      if (partner && partner.waiting === 'netting') partner.waiting = undefined;
      await this.d.ledger.saveRungs(this.pairId, partner ? [rung, partner] : [rung]);
      return; // both rungs re-place on the next drive
    }

    if (pending === 'EXCEPTION') {
      // Stuck partial sell: buy back only what sold. The next cycle resets to a full rung.
      const next = rung.soldQty.gt(0) ? startBuyLeg(rung, this.d.specs) : rung;
      this.rungs.set(next.key, next);
      await this.d.ledger.audit(this.pairId, 'PARTIAL_SELL_EXCEPTION', { rung: rung.key, cycle: rung.cycle, sold: rung.soldQty.toFixed() });
      await this.d.ledger.saveRungs(this.pairId, [next]);
      return;
    }

    if (pending === 'REPLACE') {
      await this.d.ledger.saveRungs(this.pairId, [rung]);
      return; // drive() places the remainder under the next revision
    }

    // Nobody asked for this cancel: someone or something outside the engine touched our order.
    await this.d.ledger.saveRungs(this.pairId, [rung]);
    await this.kill(`order ${order.clientOrderId} was cancelled outside engine control`);
  }

  // ── Driving the lattice ──────────────────────────────────────────────────────────────────────

  /** Places every order that should exist and arms rungs the market has moved under. */
  private async drive() {
    if (this.status !== 'RUNNING' || !this.book) return;
    if (this.d.clock.now() < this.rateLimitedUntil) return;

    // Stuck partial sell: market reached the buyback target with the sell only partly filled.
    for (const r of this.rungs.values()) {
      if (r.state !== 'SELL_LIVE' || !r.order || r.order.status !== 'LIVE' || r.order.pending) continue;
      // "The market reaches L(n-1)": judged by the best BID. The best ask can be one of our own
      // resting sells from a lower rung, which must never trigger this rung's exception.
      if (r.legFilled.isZero() || this.book.bestBid.gt(r.buyPrice)) continue;
      const buyValue = r.buyPrice.mul(r.soldQty);
      if (buyValue.lt(this.d.specs.minOrderValue)) continue; // too small to buy back; keep waiting
      await this.cancel(r, 'EXCEPTION');
    }

    // Live rungs without an order. Buybacks first: they close cycles and must never starve.
    const pendingRungs = [...this.rungs.values()].sort((a, b) =>
      (a.state === 'BUY_LIVE' ? 0 : 1) - (b.state === 'BUY_LIVE' ? 0 : 1) || a.sellPrice.comparedTo(b.sellPrice));
    for (const r of pendingRungs) {
      if (this.status !== 'RUNNING') return;
      if (r.state !== 'IDLE' && !r.order && r.waiting !== 'netting') await this.place(r);
      if (this.stateResynced) {
        // Rung objects changed under us: start the pass again from the fresh state.
        this.stateResynced = false;
        return this.drive();
      }
    }

    await this.arm();
  }

  /**
   * Spec: an approved config change never re-prices an open cycle; it applies to a rung only when
   * its current cycle closes. A rung the new lattice no longer has stops re-selling.
   */
  private adoptLattice(r: RungRecord) {
    const l = this.lattice.find((x) => x.key === r.key);
    if (!l) {
      r.state = 'IDLE';
      return;
    }
    r.sellPrice = l.sellPrice;
    r.buyPrice = l.buyPrice;
  }

  /** IDLE -> SELL_LIVE for rungs above the best bid, nearest first, within the armed-order budget. */
  private async arm() {
    if (!this.book || this.status !== 'RUNNING') return;
    const book = this.book;
    const live = [...this.rungs.values()].filter((r) => r.order).length;
    let budget = this.tuning.armedRungs - live;
    const candidates = [...this.rungs.values()]
      .filter((r) => r.state === 'IDLE' && book.bestBid.lt(r.sellPrice))
      .sort((a, b) => a.sellPrice.comparedTo(b.sellPrice));
    if (!candidates.length || budget <= 0) return;
    // Base actually free for new sells: total held minus what live sells already promise.
    const balances = await this.d.venue.getBalances();
    let freeBase = balances.base;
    for (const o of this.rungs.values()) if (o.order?.side === 'SELL') freeBase = freeBase.minus(remaining(o));
    for (const r of candidates) {
      if (budget <= 0 || this.status !== 'RUNNING') break;
      if (freeBase.lt(this.d.cfg.rungSizeBase) || !(await this.hasBaseFor(r))) break;
      const armed = armSell(r, this.d.cfg);
      this.rungs.set(armed.key, armed);
      await this.d.ledger.saveRungs(this.pairId, [armed]);
      await this.place(armed);
      if (this.stateResynced) {
        this.stateResynced = false;
        return this.drive();
      }
      if (armed.order) {
        budget -= 1;
        freeBase = freeBase.minus(this.d.cfg.rungSizeBase);
      }
      if (!armed.order && armed.waiting && armed.waiting !== 'netting') {
        // Could not place right now (e.g. deferral): return the rung to IDLE so it is not stuck.
        const back = { ...armed, state: 'IDLE' as const, waiting: undefined };
        this.rungs.set(back.key, back);
        await this.d.ledger.saveRungs(this.pairId, [back]);
      }
    }
  }

  private async hasBaseFor(r: RungRecord): Promise<boolean> {
    let committed = this.d.cfg.rungSizeBase;
    for (const other of this.rungs.values()) {
      committed = committed.plus(owed(other));
      if (other.order?.side === 'SELL') committed = committed.plus(remaining(other));
    }
    return committed.lte(this.d.cfg.maxBaseOwed) && r.state === 'IDLE';
  }

  /** Spec pegging rules. Sells never below the rung; buys never above the target. */
  private desiredPrice(r: RungRecord, side: Side): Decimal {
    const book = this.book!;
    if (side === 'SELL') return book.bestBid.lt(r.sellPrice) ? r.sellPrice : Decimal.max(r.sellPrice, book.bestAsk);
    return book.bestAsk.gt(r.buyPrice) ? r.buyPrice : Decimal.min(r.buyPrice, book.bestBid);
  }

  /** The partner rung that would cross with this order: rung n's buyback vs rung n-1's sell. */
  private partnerOf(r: RungRecord, side: Side): RungRecord | undefined {
    const n = side === 'BUY' ? r.n - 1 : r.n + 1;
    return [...this.rungs.values()].find((o) => o.ladder === r.ladder && o.n === n);
  }

  private wouldCross(r: RungRecord, side: Side, price: Decimal): boolean {
    for (const o of this.rungs.values()) {
      if (o.key === r.key || !o.order) continue;
      if (side === 'BUY' && o.order.side === 'SELL' && price.gte(o.order.price)) return true;
      if (side === 'SELL' && o.order.side === 'BUY' && price.lte(o.order.price)) return true;
    }
    return false;
  }

  private async place(r: RungRecord) {
    const { specs, cfg, venue, ledger } = this.d;
    if (this.status !== 'RUNNING' || !this.book || r.order || this.epoch === null) return;
    const side: Side = r.state === 'SELL_LIVE' ? 'SELL' : 'BUY';
    const qty = remaining(r);
    if (qty.lt(specs.lot)) return;
    const price = this.desiredPrice(r, side);
    const liveOrders = [...this.rungs.values()].filter((o) => o.order).length;
    if (liveOrders >= specs.maxOpenOrders) {
      if (r.waiting !== 'venue order limit') {
        r.waiting = 'venue order limit';
        await ledger.saveRungs(this.pairId, [r]);
      }
      return;
    }

    // Internal netting: same price, same quantity, resting partner with no fills.
    const partner = this.partnerOf(r, side);
    if (partner?.order && partner.order.status === 'LIVE' && !partner.order.pending && partner.order.price.eq(price)
      && partner.order.side !== side && partner.legFilled.isZero()) {
      const sellQty = side === 'SELL' ? qty : remaining(partner);
      const buyNeed = side === 'BUY' ? owed(r) : owed(partner);
      if (sellQty.eq(buyNeed) && (side === 'SELL' ? r.legFilled.isZero() : r.boughtGross.isZero())) {
        partner.order.pending = 'NET';
        partner.order.netWith = r.key;
        r.waiting = 'netting';
        await ledger.saveRungs(this.pairId, [partner, r]);
        await this.safeCancel(partner);
        return;
      }
    }

    // Self-trade guard: defer instead of resting an order that could match one of ours.
    if (this.wouldCross(r, side, price)) {
      if (r.waiting !== 'self-cross deferral') {
        r.waiting = 'self-cross deferral';
        await ledger.saveRungs(this.pairId, [r]);
      }
      return;
    }

    const balances = await venue.getBalances();
    const result = await this.gate.check({ rung: r, side, price, qty, epoch: this.epoch }, { rungs: [...this.rungs.values()], balances });
    if (!result.ok) {
      const gate = result as Extract<GateResult, { ok: false }>;
      if (gate.code === 'INSUFFICIENT_BALANCE') {
        // The venue's balance may already include a fill we have not processed (the public book
        // often arrives before the private fill). Catch up first; only a shortfall that survives
        // the re-sync is real.
        const applied = await this.syncMissedFills();
        if (applied > 0) {
          this.stateResynced = true;
          return;
        }
      }
      if (gate.code === 'BASE_CAP') {
        r.waiting = 'base cap';
        await ledger.saveRungs(this.pairId, [r]);
        return;
      }
      if (gate.code === 'STALE_EPOCH') {
        this.status = 'STOPPED';
        this.statusReason = 'lease epoch is stale';
        await ledger.audit(this.pairId, 'GATE_STALE_EPOCH', { epoch: this.epoch });
        return;
      }
      return this.kill(`risk gate rejected ${side} on ${r.key}: ${gate.code} ${gate.message}`);
    }

    // Record the intent BEFORE sending, under a never-used ID.
    const revision = r.revision + 1;
    const clientOrderId = buildOrderId(cfg.symbol, r.key, r.cycle, side, revision);
    r.revision = revision;
    r.waiting = undefined;
    const target = side === 'SELL' ? r.sellPrice : r.buyPrice;
    r.order = {
      clientOrderId, side, price, qty, revision, status: 'INTENT', placedAt: this.d.clock.now(), filled: ZERO,
      pegged: !price.eq(target),
    };
    await ledger.saveRungs(this.pairId, [r]);

    let res;
    try {
      res = await venue.placeOrder({ clientOrderId, side, price, qty });
    } catch (e) {
      // Ambiguous: leave the INTENT in place; resolveIntents() looks it up by client ID.
      this.d.log.warn(`[${this.pairId}] place ${clientOrderId} failed ambiguously: ${(e as Error).message}`);
      return;
    }
    if (res.ok) {
      r.order = { ...r.order, status: 'LIVE', orderId: res.orderId };
      await ledger.saveRungs(this.pairId, [r]);
      this.rateLimitBackoffMs = 1000;
      return;
    }
    switch (res.reason) {
      case 'WOULD_CROSS':
        // Post-only rejected: re-price from a fresh book on the next tick under a new revision.
        r.order = null;
        await ledger.saveRungs(this.pairId, [r]);
        return;
      case 'RATE_LIMIT':
        this.rateLimitedUntil = this.d.clock.now() + this.rateLimitBackoffMs;
        this.rateLimitBackoffMs = Math.min(this.rateLimitBackoffMs * 2, 60_000);
        return; // INTENT stays; it is looked up by client ID before any retry
      case 'PRICE_LIMIT':
        r.order = null;
        r.waiting = 'venue price limit';
        await ledger.saveRungs(this.pairId, [r]);
        if (r.state === 'SELL_LIVE' && r.soldQty.isZero()) {
          const back = { ...r, state: 'IDLE' as const, waiting: undefined };
          this.rungs.set(back.key, back);
          await ledger.saveRungs(this.pairId, [back]);
        }
        return;
      case 'UNAVAILABLE':
        r.order = null;
        await ledger.saveRungs(this.pairId, [r]);
        this.status = 'PAUSED';
        this.statusReason = `venue unavailable: ${res.message}`;
        await ledger.audit(this.pairId, 'PAUSED', { reason: res.message });
        await this.d.alert.send(`⏸ ${this.pairId}: paused, venue unavailable (${res.message})`);
        return;
      default:
        // INSUFFICIENT_BALANCE is an invariant breach; INVALID (tick/lot/min) should be impossible.
        r.order = null;
        await ledger.saveRungs(this.pairId, [r]);
        return this.kill(`venue rejected ${clientOrderId}: ${res.reason} ${res.message}`);
    }
  }

  /** INTENT orders whose placement result is unknown: look them up by client ID, never resend blindly. */
  private async resolveIntents() {
    if (this.d.clock.now() < this.rateLimitedUntil) return;
    for (const r of this.rungs.values()) {
      if (r.order?.status !== 'INTENT') continue;
      if (this.d.clock.now() - r.order.placedAt < 2000) continue;
      const found = await this.d.venue.findOrder(r.order.clientOrderId);
      if (found.found && found.open && !found.cancelled) {
        r.order = { ...r.order, status: 'LIVE', orderId: found.open.orderId };
      } else if (found.found && found.filledQty?.gt(0)) {
        continue; // fills will arrive (or the REST poll replays them)
      } else {
        r.order = null; // never reached the venue: next attempt uses a new revision
      }
      await this.d.ledger.saveRungs(this.pairId, [r]);
    }
  }

  /** Re-quote pegged orders when the market moved, no more often than the peg interval. */
  private async requote() {
    if (!this.book) return;
    const now = this.d.clock.now();
    for (const r of this.rungs.values()) {
      const o = r.order;
      if (!o || o.status !== 'LIVE' || o.pending) continue;
      // Spec: pegging applies only when the market was already through the target; otherwise the
      // order rests at its rung price and does not move.
      if (!o.pegged) continue;
      if (now - o.placedAt < this.tuning.pegRequoteMs) continue;
      const desired = this.desiredPrice(r, o.side);
      if (desired.eq(o.price)) continue;
      const left = remaining(r);
      if (left.lt(this.d.specs.lot) || left.mul(desired).lt(this.d.specs.minOrderValue)) continue;
      await this.cancel(r, 'REPLACE');
    }
  }

  private async cancel(r: RungRecord, pending: 'REPLACE' | 'EXCEPTION') {
    if (!r.order) return;
    r.order = { ...r.order, pending, status: 'CANCELING' };
    await this.d.ledger.saveRungs(this.pairId, [r]);
    await this.safeCancel(r);
  }

  private async safeCancel(r: RungRecord) {
    if (!r.order) return;
    if (r.order.status !== 'CANCELING') {
      r.order = { ...r.order, status: 'CANCELING' };
      await this.d.ledger.saveRungs(this.pairId, [r]);
    }
    try {
      await this.d.venue.cancelOrder(r.order.clientOrderId);
    } catch (e) {
      this.d.log.warn(`[${this.pairId}] cancel ${r.order.clientOrderId} failed: ${(e as Error).message}`);
    }
  }

  /**
   * Netting: rung n's buyback and rung n-1's sell at the same price and quantity. Neither trade is
   * sent; both are booked internally with zero fees. Balances end up identical to doing both trades,
   * minus the two fees we did not pay.
   */
  private async bookNetting(cancelled: RungRecord, partner: RungRecord, price: Decimal) {
    const { cfg, specs, ledger, clock } = this.d;
    const sellRung = cancelled.state === 'SELL_LIVE' ? cancelled : partner;
    const buyRung = cancelled.state === 'BUY_LIVE' ? cancelled : partner;
    if (sellRung.state !== 'SELL_LIVE' || buyRung.state !== 'BUY_LIVE') {
      partner.waiting = undefined;
      await ledger.saveRungs(this.pairId, [cancelled, partner]);
      return;
    }
    const qty = owed(buyRung);
    const ts = clock.now();
    const sellRev = sellRung.revision + 1;
    const buyRev = buyRung.revision + 1;
    const sellFill: Fill = {
      fillId: `NET:${sellRung.key}:C${sellRung.cycle}:S${sellRev}`, clientOrderId: buildOrderId(cfg.symbol, sellRung.key, sellRung.cycle, 'SELL', sellRev),
      orderId: 'netted', side: 'SELL', price, qty, feeAmount: ZERO, feeAsset: 'quote', ts, netted: true,
    };
    const buyFill: Fill = {
      fillId: `NET:${buyRung.key}:C${buyRung.cycle}:B${buyRev}`, clientOrderId: buildOrderId(cfg.symbol, buyRung.key, buyRung.cycle, 'BUY', buyRev),
      orderId: 'netted', side: 'BUY', price, qty, feeAmount: ZERO, feeAsset: 'base', ts, netted: true,
    };
    const s0 = { ...sellRung, revision: sellRev, order: null, waiting: undefined };
    // The netted buy needs exactly the base owed (no fee is taken), so the leg target is that amount.
    const b0 = { ...buyRung, revision: buyRev, order: null, waiting: undefined, legQty: buyRung.legFilled.plus(qty) };
    const s1 = applyFill(s0, sellFill, cfg, specs);
    const b1 = applyFill(b0, buyFill, cfg, specs);
    const applied = await ledger.commit(this.pairId, { fills: [sellFill, buyFill], rungs: [s1.rung, b1.rung], cycle: b1.cycle });
    if (!applied) return;
    this.rungs.set(s1.rung.key, s1.rung);
    this.rungs.set(b1.rung.key, b1.rung);
    if (b1.cycle) {
      this.cycles.push(b1.cycle);
      this.profitBalance = this.profitBalance.plus(b1.cycle.profit);
    }
    await ledger.audit(this.pairId, 'NETTED', { sell: sellRung.key, buy: buyRung.key, price: price.toFixed(), qty: qty.toFixed() });
  }

  // ── Invariants and the kill switch ───────────────────────────────────────────────────────────

  private async collectBreaches(): Promise<Breach[]> {
    const { ledger, venue, cfg, specs } = this.d;
    const genesis = await ledger.getGenesis(this.pairId);
    if (!genesis) return [{ id: 'GENESIS', message: 'no genesis', left: 'none', right: 'required' }];
    const [balances, openOrders] = await Promise.all([venue.getBalances(), venue.getOpenOrders()]);
    const leaseValid = this.epoch !== null && (await this.d.lease.verify(this.pairId, this.d.holder, this.epoch));
    this.lastInvariantCheck = this.d.clock.now();
    return checkInvariants({
      cfg, specs, genesis, balances, rungs: [...this.rungs.values()], openOrders, cycles: this.cycles,
      sweepsTotal: this.sweeps, profitBalance: this.profitBalance, leaseValid, runningHash: this.runningHash,
      approvedHash: this.d.approvedHash(), requireApproval: this.d.mode === 'live', nowMs: this.d.clock.now(),
    });
  }

  private async runInvariants(context: string) {
    if (this.status !== 'RUNNING') return;
    let breaches = await this.collectBreaches();
    // Balances can include a fill the private feed has not delivered yet. Before treating a breach
    // as real: wait a moment (live), pull any missed fills from the venue, and check again.
    if (breaches.length) {
      if (this.d.recheckDelayMs) await new Promise((r) => setTimeout(r, this.d.recheckDelayMs));
      const applied = await this.syncMissedFills();
      if (this.status !== 'RUNNING') return;
      if (applied > 0 || this.d.recheckDelayMs) breaches = await this.collectBreaches();
    }
    this.lastBreaches = breaches;
    if (!breaches.length) {
      this.pollStrikes = 0;
      return;
    }
    // A disagreement between our order map and the venue's (I4/I5, not epoch) only halts the
    // engine when it persists across two REST polls; in-flight orders explain a single miss.
    const orderMapOnly = breaches.every((b) => b.id === 'I4' || (b.id === 'I5' && b.left !== 'stale'));
    if (orderMapOnly) {
      if (context !== 'poll') return;
      this.pollStrikes += 1;
      if (this.pollStrikes < 2) return;
    }
    const global = breaches.some((b) => b.global);
    // "Every pair" means every pair of THIS user; other users are never affected.
    if (global) await this.d.ledger.setKilled(scopeId(this.d.ownerId, '*'), true, `engine:${this.pairId}`);
    await this.kill(breaches.map((b) => `${b.id}: ${b.message} (${b.left} vs ${b.right})`).join('; '));
  }

  /** Cancels every open order, freezes rungs in their state, records it and pages a human. */
  /**
   * Cancels every open order, freezes rungs in their state, records it and pages a human.
   * `recoverable` is only for lost feeds: once data flows again the engine runs the full restart
   * procedure by itself. Every other trigger latches until a human resumes.
   */
  private async kill(reason: string, recoverable = false) {
    if (this.status === 'KILLED') return;
    this.status = 'KILLED';
    this.statusReason = reason;
    this.autoRecover = recoverable;
    this.d.log.error(`[${this.pairId}] KILL SWITCH: ${reason}`);
    try {
      await this.d.venue.cancelAll();
    } catch (e) {
      this.d.log.error(`[${this.pairId}] cancelAll failed during kill: ${(e as Error).message}`);
    }
    for (const r of this.rungs.values()) {
      if (r.order) r.order = { ...r.order, status: 'CANCELING', pending: undefined };
    }
    await this.d.ledger.saveRungs(this.pairId, [...this.rungs.values()]);
    if (!recoverable) await this.d.ledger.setKilled(this.pairId, true, 'engine');
    await this.d.ledger.audit(this.pairId, 'KILL', { reason, autoRecover: recoverable });
    await this.d.alert.send(`🛑 ${this.pairId} KILL SWITCH: ${reason}${recoverable ? ' (restarts by itself once data returns)' : ''}`);
  }
}
