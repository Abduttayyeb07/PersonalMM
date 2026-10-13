import Decimal from 'decimal.js';
import { LiveOrder } from '../engine/rung-accounting';
import { Lease } from '../engine/supervisor/lease';
import { Alerter, Book, Clock, Fill, Logger, OrderUpdate, Side, VenueSpecs } from '../engine/types';
import { VenueAdapter } from '../engine/venue/venue';
import { applySeriesFill, cloneSlot, newSlot, owed, remaining, reserveOf } from './accounting';
import { buildSeriesOrderId, parseSeriesOrderId } from './order-id';
import { SeriesStore } from './store';
import { Slot, SeriesCycle, SeriesPlan, SeriesRun } from './types';

const ZERO = new Decimal(0);

export type SeriesStatus = 'STARTING' | 'RUNNING' | 'PAUSED' | 'HALTED' | 'STOPPED';

export interface SeriesEngineDeps {
  run: SeriesRun;
  plan: SeriesPlan;
  specs: VenueSpecs;
  venue: VenueAdapter;
  store: SeriesStore;
  lease: Lease;
  /** Lease key: one writer per user and mode. */
  leaseScope: string;
  holder: string;
  clock: Clock;
  log: Logger;
  alert: Alerter;
  symbol: string;
  feedStaleSeconds: number;
  leaseTtlSeconds: number;
  /** Delay before re-checking a balance breach, so a fill/balance race is not a false halt (live). */
  recheckDelayMs?: number;
}

export interface SeriesSnapshot {
  runId: string;
  seriesNo: number;
  status: SeriesStatus;
  statusReason?: string;
  book: { bestBid: string; bestAsk: string } | null;
  liveOrders: number;
  sellsLive: number;
  buysLive: number;
  cyclesCompleted: number;
  realisedProfit: string;
  zigSold: string;
  reserve: string;
  lastCheck: number | null;
  breaches: string[];
}

/**
 * One series: N sell orders go up the ladder from the base price. Every sell that fills places a
 * buyback below it; every buyback that fills books its profit and places a re-sell above it. The loop
 * runs until the user stops the series. Every order is a post-only limit order; nothing is ever sent
 * at market, and a buyback exists only because its sell filled first.
 */
export class SeriesEngine {
  private readonly slots = new Map<number, Slot>();
  private cycles: SeriesCycle[] = [];
  private status: SeriesStatus = 'STARTING';
  private statusReason?: string;
  private epoch: number | null = null;
  private book: Book | null = null;
  private lastMarketTs = 0;
  private marketDownSince: number | null = null;
  private privateDownSince: number | null = null;
  private autoRecover = false;
  private lastCheck: number | null = null;
  private lastBreaches: string[] = [];
  private pollStrikes = 0;
  private rateLimitedUntil = 0;
  private rateLimitBackoffMs = 1000;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: SeriesEngineDeps) {}

  // ── Public surface ───────────────────────────────────────────────────────────────────────────

  get runId() { return this.d.run.id; }
  getStatus() { return this.status; }
  getSlots(): Slot[] { return [...this.slots.values()].map(cloneSlot).sort((a, b) => a.slot - b.slot); }
  getCycles(): SeriesCycle[] { return [...this.cycles]; }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  idle(): Promise<void> { return this.enqueue(async () => undefined); }
  onBook(book: Book) { return this.enqueue(() => this.handleBook(book)); }
  onFill(fill: Fill) { return this.enqueue(() => this.handleFill(fill)); }
  onOrderUpdate(u: OrderUpdate) { return this.enqueue(() => this.handleOrderUpdate(u)); }
  onFeedStatus(feed: 'market' | 'private', connected: boolean) {
    return this.enqueue(async () => {
      const now = this.d.clock.now();
      if (feed === 'market') this.marketDownSince = connected ? null : (this.marketDownSince ?? now);
      else this.privateDownSince = connected ? null : (this.privateDownSince ?? now);
    });
  }
  /** Staleness, intent resolution, retries. Call about once a second. */
  tick() { return this.enqueue(() => this.handleTick()); }
  /** REST cross-check of fills and invariants (about every 30 s). */
  poll() { return this.enqueue(() => this.handlePoll()); }
  checkNow() { return this.enqueue(() => this.runChecks('now')); }
  /** Self-healing after a lost feed: restart by itself once data is flowing again. */
  recover() { return this.enqueue(() => this.handleRecover()); }

  async renewLease(): Promise<boolean> {
    if (this.epoch === null || this.status === 'STOPPED' || this.status === 'HALTED') return false;
    const ok = await this.d.lease.renew(this.d.leaseScope, this.d.holder, this.epoch, this.d.leaseTtlSeconds * 1000);
    if (!ok) {
      await this.enqueue(async () => {
        this.status = 'STOPPED';
        this.statusReason = 'lease lost';
        await this.d.store.event(this.runId, 'LEASE_LOST', { holder: this.d.holder });
        await this.d.store.stopRun(this.runId, 'lease lost to another instance');
      });
    }
    return ok;
  }

  /**
   * Places the first sells. Throws if the account cannot cover them. With `resume`, picks up a series
   * that was running before a restart: its loops and booked profit are kept and every order that
   * should exist is placed again.
   */
  start(resume?: { slots: Slot[]; cycles: SeriesCycle[] }): Promise<SeriesStatus> {
    return this.enqueue(async () => {
      // Check funds before taking the lease, so a refused start leaves nothing held.
      const balances = await this.d.venue.getBalances();
      const needed = this.d.plan.zigForSale;
      if (!resume && balances.base.lt(needed)) {
        this.status = 'STOPPED';
        this.statusReason = `not enough ZIG: hold ${balances.base.toFixed()}, orders need ${needed.toFixed()}`;
        await this.d.store.stopRun(this.runId, this.statusReason);
        throw new Error(`The account holds ${balances.base.toFixed()} ZIG but the orders need ${needed.toFixed()} ZIG`);
      }
      const epoch = await this.d.lease.acquire(this.d.leaseScope, this.d.holder, this.d.leaseTtlSeconds * 1000);
      if (epoch === null) {
        this.status = 'STOPPED';
        this.statusReason = 'another instance holds the lease';
        await this.d.store.stopRun(this.runId, this.statusReason);
        return this.status;
      }
      this.epoch = epoch;
      if (resume) {
        // Orders from before the restart no longer exist: clear them so drive() places them again.
        const slots = resume.slots.map((s) => ({ ...cloneSlot(s), order: null, waiting: undefined }));
        for (const s of slots) this.slots.set(s.slot, s);
        this.cycles = [...resume.cycles];
        await this.d.store.saveSlots(this.runId, slots);
        await this.d.store.event(this.runId, 'RESUMED', { after: 'backend restart', cycles: this.cycles.length });
      } else {
        const slots = this.d.plan.orders.map((o) => newSlot(o.slot, this.d.plan.qty, o.sellPrice));
        for (const s of slots) this.slots.set(s.slot, s);
        await this.d.store.saveSlots(this.runId, slots);
        await this.d.store.event(this.runId, 'SERIES_STARTED', {
          base: this.d.plan.basePrice.toFixed(), orders: slots.length, qtyPerOrder: this.d.plan.qty.toFixed(),
          firstSell: slots[0]?.sellTarget.toFixed(), lastSell: slots[slots.length - 1]?.sellTarget.toFixed(),
        });
      }
      this.status = 'RUNNING';
      this.book = await this.d.venue.getBook().catch(() => null);
      if (this.book) this.lastMarketTs = this.d.clock.now();
      await this.drive();
      return this.status;
    });
  }

  /**
   * The user ends the series: every order is removed, the profit stays recorded. ZIG whose buyback
   * had not filled yet stays sold (it is now USDT); this is reported in the stop event.
   */
  stop(reason = 'stopped by user'): Promise<SeriesSnapshot> {
    return this.enqueue(async () => {
      if (this.status !== 'STOPPED' && this.status !== 'HALTED') {
        await this.cancelEverything();
        this.status = 'STOPPED';
        this.statusReason = reason;
        const open = [...this.slots.values()].filter((s) => owed(s).gt(0));
        await this.d.store.event(this.runId, 'SERIES_STOPPED', {
          reason, cycles: this.cycles.length, profit: this.profit().toFixed(),
          zigStillSold: open.reduce((n, s) => n.plus(owed(s)), ZERO).toFixed(), openLoops: open.length,
        });
        await this.d.store.stopRun(this.runId, reason);
        if (this.epoch !== null) await this.d.lease.release(this.d.leaseScope, this.d.holder, this.epoch);
      }
      return this.snapshot();
    });
  }

  snapshot(): SeriesSnapshot {
    const slots = [...this.slots.values()];
    return {
      runId: this.runId, seriesNo: this.d.run.seriesNo, status: this.status, statusReason: this.statusReason,
      book: this.book ? { bestBid: this.book.bestBid.toFixed(), bestAsk: this.book.bestAsk.toFixed() } : null,
      liveOrders: slots.filter((s) => s.order).length,
      sellsLive: slots.filter((s) => s.order?.side === 'SELL').length,
      buysLive: slots.filter((s) => s.order?.side === 'BUY').length,
      cyclesCompleted: this.cycles.length, realisedProfit: this.profit().toFixed(),
      zigSold: slots.reduce((n, s) => n.plus(owed(s)), ZERO).toFixed(),
      reserve: slots.reduce((n, s) => n.plus(reserveOf(s)), ZERO).toFixed(),
      lastCheck: this.lastCheck, breaches: this.lastBreaches,
    };
  }

  private profit(): Decimal {
    return this.cycles.reduce((n, c) => n.plus(c.profit), ZERO);
  }

  // ── Events (always inside the queue) ─────────────────────────────────────────────────────────

  private async handleBook(book: Book) {
    this.book = book;
    this.lastMarketTs = this.d.clock.now();
    if (this.status === 'RUNNING') await this.drive();
  }

  private async handleTick() {
    if (this.status !== 'RUNNING') return;
    const now = this.d.clock.now();
    const stale = this.d.feedStaleSeconds * 1000;
    if (now - this.lastMarketTs > stale) return this.pause('market data feed stale');
    if (this.marketDownSince !== null && now - this.marketDownSince > stale) return this.pause('market feed disconnected');
    if (this.privateDownSince !== null && now - this.privateDownSince > stale) return this.pause('private feed stale');
    await this.resolveIntents();
    await this.drive();
  }

  private async handlePoll() {
    if (this.status !== 'RUNNING') return;
    await this.syncMissedFills();
    if (this.status !== 'RUNNING') return;
    await this.runChecks('poll');
    if (this.status === 'RUNNING') await this.drive();
  }

  private async handleRecover() {
    if (this.status !== 'PAUSED' || !this.autoRecover) return;
    const stale = this.d.feedStaleSeconds * 1000;
    const healthy = this.d.clock.now() - this.lastMarketTs <= stale && this.marketDownSince === null && this.privateDownSince === null;
    if (!healthy) return;
    // Catch up on anything that happened while we were blind, then re-place the orders.
    await this.syncMissedFills();
    if ((this.status as SeriesStatus) === 'HALTED') return;
    this.status = 'RUNNING';
    this.statusReason = undefined;
    this.autoRecover = false;
    await this.d.store.event(this.runId, 'RESUMED', { after: 'feeds recovered' });
    await this.runChecks('recover');
    if (this.status === 'RUNNING') await this.drive();
  }

  private async handleFill(fill: Fill) {
    await this.applyFillEvent(fill, true);
  }

  private async handleOrderUpdate(u: OrderUpdate) {
    if (this.status !== 'RUNNING') return; // our own cancels during a pause or stop
    const slot = [...this.slots.values()].find((s) => s.order?.clientOrderId === u.clientOrderId);
    if (!slot?.order) return;
    if (u.status === 'REJECTED') {
      const next = cloneSlot(slot);
      next.order = null;
      this.slots.set(next.slot, next);
      await this.d.store.saveSlots(this.runId, [next]);
      return;
    }
    // Nobody asked for this cancel: something outside the engine touched our order.
    await this.halt(`order ${u.clientOrderId} was cancelled outside engine control`);
  }

  // ── Fills ────────────────────────────────────────────────────────────────────────────────────

  private async applyFillEvent(fill: Fill, drive: boolean) {
    if (this.status === 'HALTED' || this.status === 'STOPPED') return;
    if (await this.d.store.hasFill(this.runId, fill.fillId)) return;
    const id = parseSeriesOrderId(fill.clientOrderId);
    if (!id || id.symbol !== this.d.symbol || id.seriesNo !== this.d.run.seriesNo) {
      return this.halt(`fill ${fill.fillId} has a client id this series did not issue (${fill.clientOrderId})`);
    }
    const slot = this.slots.get(id.slot);
    if (!slot) return this.halt(`fill ${fill.fillId} names unknown slot ${id.slot}`);
    const expected: Side = slot.state === 'SELL_LIVE' ? 'SELL' : 'BUY';
    if (id.cycle !== slot.cycle || fill.side !== expected) {
      return this.halt(`fill ${fill.fillId} (${fill.side}, cycle ${id.cycle}) does not match slot ${slot.slot} (${expected}, cycle ${slot.cycle})`);
    }

    let result;
    try {
      result = applySeriesFill(slot, fill, this.d.run.settings, this.d.specs);
    } catch (e) {
      return this.halt(`could not apply fill ${fill.fillId}: ${(e as Error).message}`);
    }
    const next = result.slot;
    if (result.outcome === 'PARTIAL' && slot.order) {
      next.order = { ...slot.order };
      if (next.order.clientOrderId === fill.clientOrderId) next.order.filled = next.order.filled.plus(fill.qty);
    }
    if (!(await this.d.store.commit(this.runId, { fills: [fill], slots: [next], cycle: result.cycle }))) return;
    this.slots.set(next.slot, next);

    if (result.cycle) {
      this.cycles.push(result.cycle);
      await this.d.store.event(this.runId, 'CYCLE', {
        slot: result.cycle.slot, cycle: result.cycle.cycle, profit: result.cycle.profit.toFixed(),
        sold: result.cycle.avgSell.toFixed(), bought: result.cycle.avgBuy.toFixed(), qty: result.cycle.soldQty.toFixed(),
      });
      if (result.cycle.profit.isNegative()) return this.halt(`cycle ${result.cycle.slot}#${result.cycle.cycle} closed with negative profit ${result.cycle.profit.toFixed()}`);
    } else if (result.outcome === 'SELL_DONE') {
      await this.d.store.event(this.runId, 'SOLD', { slot: next.slot, cycle: next.cycle, qty: next.soldQty.toFixed(), at: fill.price.toFixed(), buyAt: next.buyTarget?.toFixed() });
    }
    if (drive && this.status === 'RUNNING') {
      await this.runChecks('fill');
      if (this.status === 'RUNNING') await this.drive();
    }
  }

  /** Applies fills the venue has that we do not (missed by the private feed). */
  private async syncMissedFills(): Promise<number> {
    const lastTs = (await this.d.store.listFills(this.runId)).reduce((m, f) => Math.max(m, f.ts), 0);
    let applied = 0;
    for (const f of (await this.d.venue.getFillsSince(Math.max(0, lastTs - 5 * 60 * 1000))).sort((a, b) => a.ts - b.ts)) {
      if (await this.d.store.hasFill(this.runId, f.fillId)) continue;
      const id = parseSeriesOrderId(f.clientOrderId);
      if (!id || id.seriesNo !== this.d.run.seriesNo) continue; // another series' fills on the same account
      await this.applyFillEvent(f, false);
      applied += 1;
      if (this.status === 'HALTED') break;
    }
    return applied;
  }

  // ── Placing orders ───────────────────────────────────────────────────────────────────────────

  /** Places every order that should exist: buybacks first (they close loops), then sells. */
  private async drive() {
    if (this.status !== 'RUNNING' || !this.book) return;
    if (this.d.clock.now() < this.rateLimitedUntil) return;
    const order = [...this.slots.values()]
      .sort((a, b) => (a.state === 'BUY_LIVE' ? 0 : 1) - (b.state === 'BUY_LIVE' ? 0 : 1) || a.slot - b.slot)
      .map((s) => s.slot);
    for (const n of order) {
      if (this.status !== 'RUNNING') return;
      const slot = this.slots.get(n);
      if (slot && !slot.order) await this.place(slot);
    }
  }

  /** Where the order for this slot should rest, never worse than its target. */
  private desiredPrice(slot: Slot): Decimal {
    const book = this.book!;
    if (slot.state === 'SELL_LIVE') {
      // Rests at its target. If the market is already above the target it sits at the best ask
      // instead (a better price for us), never below the target.
      return book.bestBid.lt(slot.sellTarget) ? slot.sellTarget : Decimal.max(slot.sellTarget, book.bestAsk);
    }
    const target = slot.buyTarget!;
    return book.bestAsk.gt(target) ? target : Decimal.min(target, book.bestBid);
  }

  private async place(slot: Slot) {
    const { specs, venue, store } = this.d;
    if (this.status !== 'RUNNING' || !this.book || slot.order || this.epoch === null) return;
    const side: Side = slot.state === 'SELL_LIVE' ? 'SELL' : 'BUY';
    const qty = remaining(slot);
    if (qty.lt(specs.lot)) return;
    const price = this.desiredPrice(slot);
    if (price.mul(qty).lt(specs.minOrderValue)) return this.wait(slot, 'below the exchange minimum order');

    // Never rest an order that could match one of our own.
    for (const o of this.slots.values()) {
      if (o.slot === slot.slot || !o.order) continue;
      if ((side === 'BUY' && o.order.side === 'SELL' && price.gte(o.order.price)) || (side === 'SELL' && o.order.side === 'BUY' && price.lte(o.order.price))) {
        return this.wait(slot, 'self-cross deferral');
      }
    }

    // Fencing: only the current lease holder sends orders.
    if (!(await this.d.lease.verify(this.d.leaseScope, this.d.holder, this.epoch))) {
      this.status = 'STOPPED';
      this.statusReason = 'lease epoch is stale';
      await store.stopRun(this.runId, this.statusReason);
      return;
    }

    // Never spend more than we hold, counting every other live order.
    const balances = await venue.getBalances();
    let committed = side === 'SELL' ? qty : price.mul(qty);
    for (const o of this.slots.values()) {
      if (o.slot !== slot.slot && o.order?.side === side) committed = committed.plus(side === 'SELL' ? remaining(o) : o.order.price.mul(remaining(o)));
    }
    if ((side === 'SELL' ? balances.base : balances.quote).lt(committed)) {
      // The venue's balance may already include a fill we have not processed yet: catch up first.
      if ((await this.syncMissedFills()) > 0) return;
      return this.halt(`not enough ${side === 'SELL' ? 'ZIG' : 'USDT'} for ${side} on slot ${slot.slot}: need ${committed.toFixed(4)}, hold ${(side === 'SELL' ? balances.base : balances.quote).toFixed(4)}`);
    }

    // Record the intent BEFORE sending, under a never-used ID.
    const next = cloneSlot(slot);
    next.revision += 1;
    next.waiting = undefined;
    const target = side === 'SELL' ? slot.sellTarget : slot.buyTarget!;
    const clientOrderId = buildSeriesOrderId(this.d.symbol, this.d.run.seriesNo, slot.slot, slot.cycle, side, next.revision);
    next.order = { clientOrderId, side, price, qty, revision: next.revision, status: 'INTENT', placedAt: this.d.clock.now(), filled: ZERO, pegged: !price.eq(target) } as LiveOrder;
    this.slots.set(next.slot, next);
    await store.saveSlots(this.runId, [next]);

    let res;
    try {
      res = await venue.placeOrder({ clientOrderId, side, price, qty });
    } catch (e) {
      this.d.log.warn(`place ${clientOrderId} failed ambiguously: ${(e as Error).message}`);
      return; // INTENT stays; resolveIntents() looks it up by client ID
    }
    if (res.ok) {
      next.order = { ...next.order, status: 'LIVE', orderId: res.orderId };
      await store.saveSlots(this.runId, [next]);
      this.rateLimitBackoffMs = 1000;
      return;
    }
    switch (res.reason) {
      case 'WOULD_CROSS':
      case 'PRICE_LIMIT':
        next.order = null; // re-priced from a fresh book on the next tick, under a new revision
        await store.saveSlots(this.runId, [next]);
        return;
      case 'RATE_LIMIT':
        this.rateLimitedUntil = this.d.clock.now() + this.rateLimitBackoffMs;
        this.rateLimitBackoffMs = Math.min(this.rateLimitBackoffMs * 2, 60_000);
        return;
      case 'UNAVAILABLE':
        next.order = null;
        await store.saveSlots(this.runId, [next]);
        return this.pause(`venue unavailable: ${res.message}`);
      default:
        next.order = null;
        await store.saveSlots(this.runId, [next]);
        return this.halt(`venue rejected ${clientOrderId}: ${res.reason} ${res.message}`);
    }
  }

  private async wait(slot: Slot, why: string) {
    if (slot.waiting === why) return;
    const next = cloneSlot(slot);
    next.waiting = why;
    this.slots.set(next.slot, next);
    await this.d.store.saveSlots(this.runId, [next]);
  }

  /** Orders whose placement result is unknown: look them up by client ID, never resend blindly. */
  private async resolveIntents() {
    if (this.d.clock.now() < this.rateLimitedUntil) return;
    for (const s of [...this.slots.values()]) {
      if (s.order?.status !== 'INTENT' || this.d.clock.now() - s.order.placedAt < 2000) continue;
      const found = await this.d.venue.findOrder(s.order.clientOrderId);
      const next = cloneSlot(s);
      if (found.found && found.open && !found.cancelled) next.order = { ...s.order, status: 'LIVE', orderId: found.open.orderId };
      else if (found.found && found.filledQty?.gt(0)) continue; // the fill is on its way (or the poll replays it)
      else next.order = null; // never reached the venue: the next attempt uses a new revision
      this.slots.set(next.slot, next);
      await this.d.store.saveSlots(this.runId, [next]);
    }
  }

  // ── Checks, pausing and halting ──────────────────────────────────────────────────────────────

  /**
   * The engine does not trust its memory: it recomputes what the balances and open orders should be
   * from its own records and compares them with the exchange.
   */
  private async runChecks(context: string) {
    if (this.status !== 'RUNNING') return;
    let breaches = await this.collectBreaches();
    if (breaches.length) {
      // A balance can include a fill the private feed has not delivered yet.
      if (this.d.recheckDelayMs) await new Promise((r) => setTimeout(r, this.d.recheckDelayMs));
      const applied = await this.syncMissedFills();
      if (this.status !== 'RUNNING') return;
      if (applied > 0 || this.d.recheckDelayMs) breaches = await this.collectBreaches();
    }
    this.lastBreaches = breaches;
    if (!breaches.length) { this.pollStrikes = 0; return; }
    // Our order map vs the exchange's must disagree on two polls in a row before we halt: orders in flight explain one.
    const orderMapOnly = breaches.every((b) => b.startsWith('orders:'));
    if (orderMapOnly) {
      if (context !== 'poll') return;
      this.pollStrikes += 1;
      if (this.pollStrikes < 2) return;
    }
    await this.halt(breaches.join('; '));
  }

  private async collectBreaches(): Promise<string[]> {
    const { venue, specs, run } = this.d;
    const [balances, open] = await Promise.all([venue.getBalances(), venue.getOpenOrders()]);
    this.lastCheck = this.d.clock.now();
    const slots = [...this.slots.values()];
    const out: string[] = [];
    // Base: what we hold plus what we have sold and not bought back equals what we started with.
    const residual = this.cycles.reduce((n, c) => n.plus(c.boughtNet).minus(c.soldQty), ZERO);
    const expectedBase = run.startZig.plus(residual).minus(slots.reduce((n, s) => n.plus(owed(s)), ZERO));
    const baseTol = specs.lot.mul(this.cycles.length + 2);
    if (balances.base.minus(expectedBase).abs().gt(baseTol)) out.push(`ZIG: hold ${balances.base.toFixed()}, records say ${expectedBase.toFixed()}`);
    // Quote: start + reserve behind open buybacks + profit.
    const expectedQuote = run.startUsdt.plus(slots.reduce((n, s) => n.plus(reserveOf(s)), ZERO)).plus(this.profit());
    if (balances.quote.minus(expectedQuote).abs().gt('0.05')) out.push(`USDT: hold ${balances.quote.toFixed(4)}, records say ${expectedQuote.toFixed(4)}`);
    // Orders: everything on the exchange belongs to a slot, and every live slot order is there.
    const ours = new Map(slots.filter((s) => s.order).map((s) => [s.order!.clientOrderId, s]));
    for (const o of open) if (!ours.has(o.clientOrderId)) out.push(`orders: unknown order ${o.clientOrderId} is open on the exchange`);
    const onVenue = new Set(open.map((o) => o.clientOrderId));
    for (const [id, s] of ours) if (s.order!.status === 'LIVE' && !onVenue.has(id)) out.push(`orders: ${id} should be live but is not on the exchange`);
    // Never a buy at or above one of our sells.
    const sells = open.filter((o) => o.side === 'SELL');
    const buys = open.filter((o) => o.side === 'BUY');
    if (sells.length && buys.length && Decimal.max(...buys.map((o) => o.price)).gte(Decimal.min(...sells.map((o) => o.price)))) {
      out.push('our highest buy is not below our lowest sell');
    }
    return out;
  }

  /** Lost feed or venue: cancel everything and wait. Restarts by itself once data returns. */
  private async pause(reason: string) {
    if (this.status !== 'RUNNING') return;
    this.status = 'PAUSED';
    this.statusReason = reason;
    this.autoRecover = true;
    this.d.log.warn(`paused: ${reason}`);
    await this.cancelEverything();
    await this.d.store.event(this.runId, 'PAUSED', { reason });
    await this.d.alert.send(`⏸ Series ${this.d.run.seriesNo} paused: ${reason} (restarts by itself once data returns)`);
  }

  /** Something is wrong: cancel everything and stop. A human decides what happens next. */
  private async halt(reason: string) {
    if (this.status === 'HALTED' || this.status === 'STOPPED') return;
    this.status = 'HALTED';
    this.statusReason = reason;
    this.d.log.error(`HALTED: ${reason}`);
    await this.cancelEverything();
    await this.d.store.event(this.runId, 'HALTED', { reason });
    await this.d.store.stopRun(this.runId, `halted: ${reason}`);
    // Orders are gone, so the lease is free for the user's next series.
    if (this.epoch !== null) await this.d.lease.release(this.d.leaseScope, this.d.holder, this.epoch).catch(() => undefined);
    await this.d.alert.send(`🛑 Series ${this.d.run.seriesNo} HALTED: ${reason}`);
  }

  private async cancelEverything() {
    try {
      await this.d.venue.cancelAll();
    } catch (e) {
      this.d.log.error(`cancelAll failed: ${(e as Error).message}`);
    }
    const cleared: Slot[] = [];
    for (const s of this.slots.values()) {
      if (!s.order) continue;
      const next = cloneSlot(s);
      next.order = null;
      this.slots.set(next.slot, next);
      cleared.push(next);
    }
    if (cleared.length) await this.d.store.saveSlots(this.runId, cleared);
  }

  /** Heartbeat for the dashboard. */
  async heartbeat() {
    const s = this.snapshot();
    await this.d.store.saveStatus(this.runId, s.status, s.statusReason, s);
  }
}
