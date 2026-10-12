import Decimal from 'decimal.js';
import { buildLattice, cycleProfit } from './lattice';
import { buildOrderId, parseOrderId } from './order-id';
import { configHash, approvalProblem, parsePairConfig, ConfigError } from './config/engine-config';
import { rebuildFromFills, owed } from './rung-accounting';
import { BYBIT_ZIG_SPECS, defaultPairConfig, makeEngine, simRig, defaultSharedConfig } from './testing';
import { readFileSync } from 'fs';
import { join } from 'path';

const D = (v: Decimal.Value) => new Decimal(v);
const small = () => defaultPairConfig({ rungSizeBase: D(1000), maxBaseOwed: D(47000) });

describe('config', () => {
  const text = readFileSync(join(__dirname, '..', '..', 'pairs', 'zigusdt-bybit.yaml'), 'utf8');

  it('parses the spec file', () => {
    const cfg = parsePairConfig(text);
    expect(cfg.ladders.map((l) => l.name)).toEqual(['A', 'B']);
    expect(cfg.rungSizeBase.toFixed()).toBe('12500');
  });

  it('refuses invalid files', () => {
    expect(() => parsePairConfig(text.replace('floor_price: 0.0500', 'floor_price: 0.2'))).toThrow(ConfigError);
    expect(() => parsePairConfig(text.replace('step: 0.03', 'step: 1.5'))).toThrow(ConfigError);
    expect(() => parsePairConfig(text.replace(/rung_size_base: \d+/, ''))).toThrow(ConfigError);
  });

  it('any money change alters the hash and needs two distinct approvers', () => {
    const cfg = parsePairConfig(text);
    const hash = configHash(cfg);
    expect(configHash({ ...cfg, rungSizeBase: D(12501) })).not.toBe(hash);
    expect(approvalProblem(cfg, { [cfg.pairId]: { hash, approvers: ['bilal', 'Bilal'] } })).toMatch(/two distinct/);
    expect(approvalProblem(cfg, { [cfg.pairId]: { hash, approvers: ['bilal', 'zahoor'] } })).toBeNull();
    expect(approvalProblem({ ...cfg, step: D('0.02') }, { [cfg.pairId]: { hash, approvers: ['bilal', 'zahoor'] } })).toMatch(/hash/);
  });
});

describe('lattice', () => {
  const cfg = defaultPairConfig();
  const lattice = buildLattice(cfg, BYBIT_ZIG_SPECS);
  const rung = (key: string) => lattice.find((r) => r.key === key)!;

  it('has 24 + 23 rungs between floor and top', () => {
    expect(lattice.filter((r) => r.ladder === 'A')).toHaveLength(24);
    expect(lattice.filter((r) => r.ladder === 'B')).toHaveLength(23);
    expect(lattice.length * 12500).toBe(587500);
  });

  it.each([
    ['A+03', '0.06557', '0.06365'], ['B+02', '0.06461', '0.06272'], ['A+01', '0.0618', '0.06'],
    ['B+00', '0.0609', '0.05912'], ['A+00', '0.06', '0.05825'], ['A-02', '0.05656', '0.0549'],
    ['A-06', '0.05025', '0.04878'], ['B+16', '0.09773', '0.09488'],
  ])('rung %s sells at %s and buys back at %s (sells round up, buys round down)', (key, sell, buy) => {
    expect(rung(key).sellPrice.toFixed()).toBe(D(sell).toFixed());
    expect(rung(key).buyPrice.toFixed()).toBe(D(buy).toFixed());
  });

  // The spec's table rounds to the nearest tick for display; its rule (sells up, buys down) is what trades.
  it('ladder A tops out at 0.09918 (the spec table says 0.09752, which does not follow its own formula)', () => {
    expect(rung('A+17').sellPrice.toFixed()).toBe('0.09918');
  });

  it('net profit per cycle matches the spec table', () => {
    const p = cycleProfit(D(12500), rung('A+01').sellPrice, rung('A+01').buyPrice, D('0.001'));
    expect(p.toDecimalPlaces(2).toNumber()).toBeCloseTo(20.98, 2);
    expect(p.div(D(12500).mul('0.06')).mul(100).toDecimalPlaces(3).toNumber()).toBeCloseTo(2.797, 3);
  });
});

describe('order ids', () => {
  it('round-trips the spec format and rejects foreign ids', () => {
    const id = buildOrderId('ZIGUSDT', 'A+01', 7, 'SELL');
    expect(id).toBe('ZIGUSDT-A+01-C0007-S');
    expect(buildOrderId('ZIGUSDT', 'A+01', 7, 'BUY', 2)).toBe('ZIGUSDT-A+01-C0007-B-r2');
    expect(parseOrderId('ZIGUSDT-B-06-C0012-B-r3')).toEqual({ symbol: 'ZIGUSDT', rungKey: 'B-06', cycle: 12, side: 'BUY', revision: 3 });
    expect(parseOrderId('manual-order-123')).toBeNull();
  });
});

describe('engine on the simulated venue', () => {
  it('arms only rungs above the market at start-up and never dumps the lower rungs', async () => {
    const rig = await simRig({ cfg: small(), startPrice: '0.0600' });
    await rig.engine.initGenesis();
    expect(await rig.engine.start()).toBe('RUNNING');
    await rig.sim.drain();
    const rungs = rig.engine.getRungs();
    for (const r of rungs) {
      if (r.sellPrice.lte('0.06')) expect(r.state).toBe('IDLE');
    }
    const open = await rig.sim.getOpenOrders();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((o) => o.side === 'SELL' && o.price.gt('0.06'))).toBe(true);
  });

  it('runs a full sell -> buyback -> re-sell cycle and books profit by the formula', async () => {
    const rig = await simRig({ cfg: small(), startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();

    await rig.step('0.0612'); // B+00 at 0.0609 sells
    let b0 = rig.engine.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.state).toBe('BUY_LIVE');
    expect(b0.order?.price.toFixed()).toBe('0.05912');
    // Rule 2: buy back the quantity sold, grossed up because Bybit takes the buy fee in ZIG.
    expect(b0.legQty.toFixed()).toBe(D(1000).div('0.999').toDecimalPlaces(2, Decimal.ROUND_UP).toFixed());

    await rig.step('0.0590'); // buyback fills
    b0 = rig.engine.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.state).toBe('SELL_LIVE');
    expect(b0.cycle).toBe(2);
    await rig.step('0.0590', 10_000); // after the peg interval the re-sell rests at its rung price
    expect(rig.engine.getRungs().find((r) => r.key === 'B+00')!.order?.price.toFixed()).toBe('0.0609');

    const cycles = rig.engine.getCycles().filter((c) => c.rungKey === 'B+00');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].profit.gt(0)).toBe(true);
    expect(cycles[0].boughtNet.minus(cycles[0].soldQty).abs().lte(rig.cfg.dustToleranceBase)).toBe(true);
    // Formula (fee on each side) agrees with the venue's base-fee mechanics to within a cent.
    const formula = cycleProfit(D(1000), D('0.0609'), D('0.05912'), D('0.001'));
    expect(cycles[0].profit.minus(formula).abs().lt('0.01')).toBe(true);

    await rig.engine.checkNow();
    expect(rig.engine.getStatus()).toBe('RUNNING');
    expect(rig.engine.snapshot().lastBreaches).toEqual([]);
  });

  it('pegs a buyback to the best bid when the market is already through the target, never above the cap', async () => {
    const rig = await simRig({ cfg: small(), startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();
    rig.sim.rateLimitNext = 1000; // hold the buyback back while the price falls through its target
    await rig.step('0.0612');
    await rig.step('0.0580');
    rig.sim.rateLimitNext = 0;
    await rig.step('0.0580', 120_000);
    await rig.step('0.0580', 120_000);
    const b0 = rig.engine.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.state).toBe('BUY_LIVE');
    expect(b0.order?.price.lte(b0.buyPrice)).toBe(true);
    expect(b0.order?.price.toFixed()).toBe('0.058');
  });

  it('stuck partial sell: cancels the remainder, buys back only what sold, then resets to a full rung', async () => {
    let first = true;
    const rig = await simRig({
      cfg: small(), startPrice: '0.0600',
      sim: { partialFill: ({ remaining }) => { if (first) { first = false; return remaining.div(2); } return remaining; } },
    });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();
    await rig.step('0.06095'); // B+00 at 0.0609 half-fills
    let b0 = rig.engine.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.state).toBe('SELL_LIVE');
    expect(b0.soldQty.toFixed()).toBe('500');

    await rig.step('0.0591'); // market reaches L(n-1): exception
    b0 = rig.engine.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.state).toBe('BUY_LIVE');
    expect(b0.legQty.toFixed()).toBe(D(500).div('0.999').toDecimalPlaces(2, Decimal.ROUND_UP).toFixed());

    await rig.step('0.0590');
    b0 = rig.engine.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.state).toBe('SELL_LIVE');
    expect(b0.legQty.toFixed()).toBe('1000');
    expect(rig.engine.getStatus()).toBe('RUNNING');
  });

  it('survives a crash: fills while down are replayed and nothing is placed twice', async () => {
    const cfg = small();
    const rig = await simRig({ cfg, startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();

    rig.sim.detach(); // the engine process dies; resting orders stay on the book
    await rig.sim.moveTo(D('0.0612')); // B+00 sells while nobody is listening
    rig.clock.advance(20_000); // lease expires

    const second = makeEngine({ cfg, shared: defaultSharedConfig(), specs: BYBIT_ZIG_SPECS, sim: rig.sim, ledger: rig.ledger, lease: rig.lease, clock: rig.clock, alerts: rig.alerts, holder: 'standby' });
    await rig.attach(second);
    expect(await second.start()).toBe('RUNNING');
    await rig.sim.drain();
    const b0 = second.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.state).toBe('BUY_LIVE');
    const open = await rig.sim.getOpenOrders();
    const ids = open.map((o) => parseOrderId(o.clientOrderId)!);
    // Exactly one order per rung, and the B+00 buyback is live.
    expect(new Set(ids.map((i) => i.rungKey)).size).toBe(open.length);
    expect(ids.some((i) => i.rungKey === 'B+00' && i.side === 'BUY')).toBe(true);
  });

  it('a second instance for the same pair never places an order', async () => {
    const cfg = small();
    const rig = await simRig({ cfg, startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    const before = (await rig.sim.getOpenOrders()).length;
    const rogue = makeEngine({ cfg, shared: defaultSharedConfig(), specs: BYBIT_ZIG_SPECS, sim: rig.sim, ledger: rig.ledger, lease: rig.lease, clock: rig.clock, alerts: rig.alerts, holder: 'rogue' });
    expect(await rogue.start()).toBe('STOPPED');
    await rogue.onBook(await rig.sim.getBook());
    expect((await rig.sim.getOpenOrders()).length).toBe(before);
  });

  it('fencing: an instance whose lease was taken over stops instead of trading', async () => {
    const cfg = small();
    const rig = await simRig({ cfg, startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();
    rig.clock.advance(20_000);
    const standby = makeEngine({ cfg, shared: defaultSharedConfig(), specs: BYBIT_ZIG_SPECS, sim: rig.sim, ledger: rig.ledger, lease: rig.lease, clock: rig.clock, alerts: rig.alerts, holder: 'standby' });
    expect(await standby.start()).toBe('RUNNING');
    expect(await rig.engine.renewLease()).toBe(false);
    expect(rig.engine.getStatus()).toBe('STOPPED');
  });

  it('applies a duplicate fill exactly once', async () => {
    const rig = await simRig({ cfg: small(), startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();
    await rig.step('0.0612');
    const fill = rig.sim.allFills[0];
    const before = rig.engine.getRungs();
    await rig.engine.onFill(fill);
    expect(rig.engine.getRungs()).toEqual(before);
    expect(rig.engine.getStatus()).toBe('RUNNING');
  });

  it('a rate-limited placement is looked up, not resent, and lands exactly once', async () => {
    const rig = await simRig({ cfg: small(), startPrice: '0.0600' });
    await rig.engine.initGenesis();
    rig.sim.rateLimitNext = 3;
    await rig.engine.start();
    for (let i = 0; i < 20; i++) await rig.step('0.0600', 5000);
    const open = await rig.sim.getOpenOrders();
    const perRung = new Map<string, number>();
    for (const o of open) perRung.set(parseOrderId(o.clientOrderId)!.rungKey, (perRung.get(parseOrderId(o.clientOrderId)!.rungKey) ?? 0) + 1);
    expect([...perRung.values()].every((n) => n === 1)).toBe(true);
    expect(rig.engine.getStatus()).toBe('RUNNING');
  });

  describe('kill switch triggers', () => {
    async function running() {
      const rig = await simRig({ cfg: small(), startPrice: '0.0600' });
      await rig.engine.initGenesis();
      await rig.engine.start();
      await rig.sim.drain();
      return rig;
    }

    it('an order cancelled outside the engine', async () => {
      const rig = await running();
      const [o] = await rig.sim.getOpenOrders();
      await rig.sim.externalCancel(o.clientOrderId);
      await rig.sim.drain();
      expect(rig.engine.getStatus()).toBe('KILLED');
      expect(await rig.sim.getOpenOrders()).toHaveLength(0);
      expect(rig.alerts.messages.join('\n')).toMatch(/KILL SWITCH/);
    });

    it('a fill with a client id we did not issue', async () => {
      const rig = await running();
      await rig.engine.onFill({ fillId: 'x1', clientOrderId: 'manual-123', orderId: 'm', side: 'SELL', price: D('0.07'), qty: D(10), feeAmount: D(0), feeAsset: 'quote', ts: rig.clock.now() });
      expect(rig.engine.getStatus()).toBe('KILLED');
    });

    it('funds moved by something the engine does not know about (I1)', async () => {
      const rig = await running();
      rig.sim.adjustBalances(D(-5000), D(0));
      await rig.engine.checkNow();
      expect(rig.engine.getStatus()).toBe('KILLED');
      expect(rig.engine.snapshot().lastBreaches.map((b) => b.id)).toContain('I1');
    });

    it('a stale market feed', async () => {
      const rig = await running();
      rig.clock.advance(61_000);
      await rig.engine.tick();
      expect(rig.engine.getStatus()).toBe('KILLED');
    });

    it('a manual stop, and restart stays down until a human resumes', async () => {
      const rig = await running();
      await rig.engine.manualKill('zoya');
      expect(rig.engine.getStatus()).toBe('KILLED');
      await rig.sim.drain();
      expect(await rig.engine.start()).toBe('KILLED');
      expect(await rig.engine.resume('subhan')).toBe('RUNNING');
    });
  });

  it('nets a buyback against the rung below instead of trading with ourselves', async () => {
    // Reachable when the spread straddles the shared price (bid < 0.06 < ask) and the public book
    // has not yet shown our own resting order. Live ZIGUSDT's spread is ~5 ticks, so this is real.
    const rig = await simRig({ cfg: small(), startPrice: '0.0615', sim: { ownOrdersInBook: false, spreadTicks: 2 } });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();
    rig.sim.rateLimitNext = 1000; // A+01's buyback is held back...
    await rig.step('0.0619'); // ...after A+01 (0.0618) sells
    await rig.step('0.05999'); // bid 0.05999 < 0.06: A+00 arms its sell at 0.06
    rig.sim.rateLimitNext = 0;
    await rig.step('0.05999', 120_000); // ask 0.06001 > cap: A+01's buyback wants exactly 0.06

    const a1 = rig.engine.getRungs().find((r) => r.key === 'A+01')!;
    const a0 = rig.engine.getRungs().find((r) => r.key === 'A+00')!;
    const netted = rig.ledger.auditLog.filter((e) => e.kind === 'NETTED');
    expect(netted).toHaveLength(1);
    expect(a1.state).toBe('SELL_LIVE'); // cycle closed internally
    expect(a1.cycle).toBe(2);
    expect(a0.state).toBe('BUY_LIVE'); // sold internally at 0.06, now buying back
    expect(rig.sim.allFills.every((f) => !(f.price.eq('0.06')))).toBe(true); // no trade at 0.06 reached the venue
    await rig.engine.checkNow();
    expect(rig.engine.getStatus()).toBe('RUNNING');
  });

  it('the rung table can be rebuilt from fill events alone', async () => {
    const rig = await simRig({ cfg: small(), startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();
    for (const p of ['0.0640', '0.0590', '0.0655', '0.0570', '0.0620']) await rig.step(p);
    const fills = await rig.ledger.listFills(rig.engine.pairId);
    const rebuilt = rebuildFromFills(rig.engine.lattice, fills, rig.cfg, BYBIT_ZIG_SPECS);
    for (const live of rig.engine.getRungs()) {
      const r = rebuilt.rungs.get(live.key)!;
      if (live.state === 'IDLE' || (live.state === 'SELL_LIVE' && live.soldQty.isZero() && r.state === 'IDLE')) continue;
      expect(r.state).toBe(live.state);
      expect(r.cycle).toBe(live.cycle);
      expect(owed(r).toFixed()).toBe(owed(live).toFixed());
    }
    expect(rebuilt.cycles.map((c) => c.profit.toFixed())).toEqual(rig.engine.getCycles().map((c) => c.profit.toFixed()));
  });
});

describe('users are independent', () => {
  it('two users running the same pair share no ledger rows, lease or kill switch', async () => {
    const { MemoryLedger } = await import('./ledger/memory-ledger');
    const { MemoryLease } = await import('./supervisor/lease');
    const { FakeClock, CapturingAlerter } = await import('./testing');
    const { SimVenue } = await import('./venue/sim-venue');
    const cfg = small();
    const clock = new FakeClock();
    const ledger = new MemoryLedger(); // one shared database, as in production
    const lease = new MemoryLease(clock);
    const make = (ownerId: string) => {
      const sim = new SimVenue({ specs: BYBIT_ZIG_SPECS, clock, startPrice: D('0.06'), startBase: D(47000), startQuote: D(0) });
      const engine = makeEngine({ cfg, shared: defaultSharedConfig(), specs: BYBIT_ZIG_SPECS, sim, ledger, lease, clock, alerts: new CapturingAlerter(), ownerId, holder: `host-${ownerId}` });
      return { sim, engine };
    };
    const a = make('alice');
    const b = make('bob');
    for (const u of [a, b]) {
      await u.sim.start({ onBook: (x) => u.engine.onBook(x), onFill: (f) => u.engine.onFill(f), onOrderUpdate: (x) => u.engine.onOrderUpdate(x), onFeedStatus: () => undefined });
      await u.engine.initGenesis();
      expect(await u.engine.start()).toBe('RUNNING'); // each holds its own lease for the same pair
      await u.sim.drain();
    }
    expect(a.engine.pairId).toBe('alice/ZIGUSDT-BYBIT');
    expect(b.engine.pairId).toBe('bob/ZIGUSDT-BYBIT');

    // Alice's "kill all my pairs" never reaches Bob.
    await ledger.setKilled('alice/*', true, 'alice');
    await a.engine.tick();
    await b.engine.tick();
    expect(a.engine.getStatus()).toBe('KILLED');
    expect(b.engine.getStatus()).toBe('RUNNING');
    expect((await b.sim.getOpenOrders()).length).toBeGreaterThan(0);
    expect(await ledger.loadRungs('alice/ZIGUSDT-BYBIT')).not.toEqual([]);
    expect((await ledger.loadRungs('bob/ZIGUSDT-BYBIT')).every((r) => !r.key.includes('alice'))).toBe(true);
    expect(() => makeEngine({ cfg, shared: defaultSharedConfig(), specs: BYBIT_ZIG_SPECS, sim: a.sim, ledger, lease, clock, alerts: new CapturingAlerter(), ownerId: 'a/b' }).pairId).toThrow();
  });
});

describe('approved config changes', () => {
  it('never re-price an open cycle; the new lattice applies when that cycle closes', async () => {
    const { MemoryLedger } = await import('./ledger/memory-ledger');
    const cfg = small();
    const rig = await simRig({ cfg, startPrice: '0.0600' });
    await rig.engine.initGenesis();
    await rig.engine.start();
    await rig.sim.drain();
    await rig.step('0.0612'); // B+00 sells at 0.0609 and opens a cycle
    expect(rig.engine.getRungs().find((r) => r.key === 'B+00')!.state).toBe('BUY_LIVE');

    // Restart under an approved config with a different base price.
    rig.sim.detach();
    rig.clock.advance(20_000);
    const next = { ...cfg, basePrice: D('0.0603') };
    const engine2 = makeEngine({ cfg: next, shared: defaultSharedConfig(), specs: BYBIT_ZIG_SPECS, sim: rig.sim, ledger: rig.ledger as InstanceType<typeof MemoryLedger>, lease: rig.lease, clock: rig.clock, alerts: rig.alerts, holder: 'new-version' });
    await rig.attach(engine2);
    await engine2.start();
    await rig.sim.drain();
    let b0 = engine2.getRungs().find((r) => r.key === 'B+00')!;
    expect(b0.buyPrice.toFixed()).toBe('0.05912'); // open cycle keeps its target
    expect(b0.order?.price.lte('0.05912')).toBe(true);

    await rig.step('0.0590'); // buyback fills, cycle closes
    b0 = engine2.getRungs().find((r) => r.key === 'B+00')!;
    const l = engine2.lattice.find((r) => r.key === 'B+00')!;
    expect(b0.cycle).toBe(2);
    expect(b0.sellPrice.toFixed()).toBe(l.sellPrice.toFixed()); // new lattice from the next cycle
    expect(b0.sellPrice.toFixed()).not.toBe('0.0609');
  });
});
