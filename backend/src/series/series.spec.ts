import Decimal from 'decimal.js';
import { parseSeriesOrderId, buildSeriesOrderId } from './order-id';
import { buildPlan, defaultSeriesSettings, SeriesSettingsError } from './plan';
import { BYBIT_ZIG_SPECS, seriesRig } from './testing';

const D = (v: Decimal.Value) => new Decimal(v);
const base059 = { basePrice: '0.059' };

describe('series plan', () => {
  it('builds the 15 sells from base 0.059: first at +3%, then 1% apart, 100 ZIG each', () => {
    const plan = buildPlan({ ...defaultSeriesSettings(), ...base059 }, D('0.058'), BYBIT_ZIG_SPECS);
    expect(plan.orders).toHaveLength(15);
    expect(plan.qty.toFixed()).toBe('100');
    expect(plan.zigForSale.toFixed()).toBe('1500');
    const prices = plan.orders.map((o) => o.price.toFixed());
    expect(prices.slice(0, 6)).toEqual(['0.06077', '0.06138', '0.06199', '0.06261', '0.06324', '0.06387']);
    expect(prices[14]).toBe('0.06985');
    expect(plan.orders[0].price.gte(D('0.059').mul('1.03'))).toBe(true); // first sell is base +3% or above
  });

  it('anchors at the market price when no base is given', () => {
    expect(buildPlan(defaultSeriesSettings(), D('0.058'), BYBIT_ZIG_SPECS).basePrice.toFixed()).toBe('0.058');
  });

  it('rejects orders below the exchange minimum and says how much ZIG is needed', () => {
    expect(() => buildPlan({ ...defaultSeriesSettings(), ...base059, totalZig: '5000' }, D('0.058'), BYBIT_ZIG_SPECS))
      .toThrow(/minimum of 5 USDT.*about 1\d{4} ZIG/);
  });

  it.each([
    [{ orders: 0 }], [{ orders: 99 }], [{ sellPct: '0' }], [{ sellPct: '150' }], [{ stepPct: '0' }],
    [{ buybackPct: '90' }], [{ totalZig: 'abc' }], [{ basePrice: '-1' }],
  ])('rejects invalid settings %j', (bad) => {
    expect(() => buildPlan({ ...defaultSeriesSettings(), ...base059, ...bad } as never, D('0.058'), BYBIT_ZIG_SPECS)).toThrow(SeriesSettingsError);
  });
});

describe('series order ids', () => {
  it('round-trips and rejects foreign ids', () => {
    const id = buildSeriesOrderId('ZIGUSDT', 1, 7, 3, 'BUY');
    expect(id).toBe('ZIGUSDT-S001-N07-C0003-B');
    expect(id.length).toBeLessThanOrEqual(36);
    expect(buildSeriesOrderId('ZIGUSDT', 12, 15, 123, 'SELL', 4)).toBe('ZIGUSDT-S012-N15-C0123-S-r4');
    expect(parseSeriesOrderId('ZIGUSDT-S012-N15-C0123-S-r4')).toEqual({ symbol: 'ZIGUSDT', seriesNo: 12, slot: 15, cycle: 123, side: 'SELL', revision: 4 });
    expect(parseSeriesOrderId('manual-1')).toBeNull();
  });
});

describe('series engine, your scenario', () => {
  const start = () => seriesRig({ settings: base059, startPrice: '0.058' });

  it('places all 15 sells at once, none at or below the base, and nothing else', async () => {
    const r = await start();
    expect(await r.engine.start()).toBe('RUNNING');
    await r.sim.drain();
    const open = await r.sim.getOpenOrders();
    expect(open).toHaveLength(15);
    expect(open.every((o) => o.side === 'SELL' && o.qty.eq(100) && o.price.gte('0.06077'))).toBe(true);
    expect(open.map((o) => o.price.toFixed()).sort()[0]).toBe('0.06077');
    expect((await r.sim.getBalances()).base.toFixed()).toBe('15000'); // nothing was sold or bought at start
  });

  it('6 sells fill -> 6 buybacks 3% below; 3 buybacks fill -> 3 re-sells 3% above; always 15 orders', async () => {
    const r = await start();
    await r.engine.start();
    await r.sim.drain();

    await r.step('0.0640'); // sells #1..#6 fill (0.06077 ... 0.06387)
    let open = await r.sim.getOpenOrders();
    const buys = open.filter((o) => o.side === 'BUY').sort((a, b) => a.price.comparedTo(b.price));
    expect(open.filter((o) => o.side === 'SELL')).toHaveLength(9);
    expect(buys.map((o) => o.price.toFixed())).toEqual(['0.05894', '0.05953', '0.06013', '0.06073', '0.06134', '0.06195']);
    expect(open).toHaveLength(15);
    // Each buyback asks for the ZIG it sold, grossed up for the fee Bybit takes in ZIG.
    expect(buys[0].qty.toFixed()).toBe(D(100).div('0.999').toDecimalPlaces(2, Decimal.ROUND_UP).toFixed());

    await r.step('0.0605'); // buybacks #6, #5, #4 fill (0.06195, 0.06134, 0.06073)
    open = await r.sim.getOpenOrders();
    const sells = open.filter((o) => o.side === 'SELL').sort((a, b) => a.price.comparedTo(b.price));
    expect(open).toHaveLength(15);
    expect(open.filter((o) => o.side === 'BUY').map((o) => o.price.toFixed()).sort()).toEqual(['0.05894', '0.05953', '0.06013']);
    // The 3 re-sells sit 3% above the buyback prices.
    expect(sells.map((o) => o.price.toFixed()).slice(0, 3)).toEqual(['0.06256', '0.06319', '0.06381']);
    expect(r.engine.getCycles()).toHaveLength(3);
    expect(r.engine.getCycles().every((c) => c.profit.gt(0))).toBe(true);
    expect(r.engine.getStatus()).toBe('RUNNING');
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
  });

  it('every loop keeps going: sell -> buy -> re-sell -> buy again', async () => {
    const r = await start();
    await r.engine.start();
    await r.sim.drain();
    for (let i = 0; i < 6; i++) { await r.step('0.0640'); await r.step('0.0585'); }
    const slot1 = r.engine.getSlots().find((s) => s.slot === 1)!;
    expect(slot1.cycle).toBeGreaterThan(3);
    expect(r.engine.getCycles().length).toBeGreaterThan(20);
    expect((await r.sim.getOpenOrders())).toHaveLength(15);
    expect(r.engine.getStatus()).toBe('RUNNING');
  });

  it('a sell that jumps over the market is placed at the best ask, never below its target', async () => {
    const r = await seriesRig({ settings: base059, startPrice: '0.0650' }); // market already above the first sells
    await r.engine.start();
    await r.sim.drain();
    const open = await r.sim.getOpenOrders();
    expect(open).toHaveLength(15);
    const book = await r.sim.getBook();
    for (const o of open) {
      const target = r.engine.getSlots().find((s) => s.order?.clientOrderId === o.clientOrderId)!.sellTarget;
      expect(o.price.gte(target)).toBe(true);
      expect(o.price.gt(book.bestBid)).toBe(true); // post-only: always a maker
    }
  });

  it('stop removes every order, keeps the profit, and reports ZIG still sold', async () => {
    const r = await start();
    await r.engine.start();
    await r.sim.drain();
    await r.step('0.0640');
    await r.step('0.0605');
    const profit = r.engine.snapshot().realisedProfit;
    const snap = await r.engine.stop('stopped by user');
    await r.sim.drain();
    expect(snap.status).toBe('STOPPED');
    expect(await r.sim.getOpenOrders()).toHaveLength(0);
    expect(r.engine.snapshot().realisedProfit).toBe(profit);
    const run = await r.store.getRun(r.engine.runId);
    expect(run?.status).toBe('STOPPED');
    const events = await r.store.listEvents(r.engine.runId, 100);
    const stopped = events.find((e) => e.kind === 'SERIES_STOPPED')!;
    expect(stopped.detail.openLoops).toBe(3); // buybacks #1..#3 never filled: that ZIG stays sold
    expect(new Decimal(String(stopped.detail.zigStillSold)).gt(299)).toBe(true);
  });

  it('a new series gets the next letter and starts clean', async () => {
    const r = await start();
    await r.engine.start();
    await r.engine.stop();
    const second = await r.store.createRun({ ownerId: 'user-a', mode: 'paper', settings: r.settings, basePrice: D('0.062'), qty: D(100), startZig: D(15000), startUsdt: D(0), startedAt: 1 });
    expect(second.seriesNo).toBe(2);
  });
});

describe('series engine safety', () => {
  it('never places an order that could match another of ours', async () => {
    const r = await seriesRig({ settings: { ...base059, stepPct: '0.5', buybackPct: '1' }, startPrice: '0.058', sim: { spreadTicks: 3, ownOrdersInBook: false } });
    await r.engine.start();
    await r.sim.drain();
    const prices = ['0.0605', '0.0640', '0.0600', '0.0635', '0.0598', '0.0642', '0.0590', '0.0650', '0.0585'];
    for (let i = 0; i < 4; i++) for (const p of prices) await r.step(p, 10_000);
    expect(r.sim.log.filter((e) => e.kind === 'place' && !e.ok && e.reason === 'INVALID')).toHaveLength(0);
    expect(r.engine.getStatus()).toBe('RUNNING');
  });

  it('halts and cancels everything when something outside the engine cancels an order', async () => {
    const r = await seriesRig({ settings: base059, startPrice: '0.058' });
    await r.engine.start();
    await r.sim.drain();
    const [o] = await r.sim.getOpenOrders();
    await r.sim.externalCancel(o.clientOrderId);
    await r.sim.drain();
    expect(r.engine.getStatus()).toBe('HALTED');
    expect(await r.sim.getOpenOrders()).toHaveLength(0);
    expect(r.alerts.messages.join('\n')).toMatch(/HALTED/);
  });

  it('halts on a fill with an id this series did not issue', async () => {
    const r = await seriesRig({ settings: base059, startPrice: '0.058' });
    await r.engine.start();
    await r.engine.onFill({ fillId: 'x', clientOrderId: 'manual-1', orderId: 'm', side: 'SELL', price: D('0.07'), qty: D(10), feeAmount: D(0), feeAsset: 'quote', ts: r.clock.now() });
    expect(r.engine.getStatus()).toBe('HALTED');
  });

  it('halts when funds move that the engine does not know about', async () => {
    const r = await seriesRig({ settings: base059, startPrice: '0.058' });
    await r.engine.start();
    await r.sim.drain();
    r.sim.adjustBalances(D(-500), D(0));
    await r.engine.checkNow();
    expect(r.engine.getStatus()).toBe('HALTED');
    expect(r.engine.snapshot().breaches.join()).toMatch(/ZIG/);
  });

  it('pauses with no market data, cancels everything, and resumes by itself when data returns', async () => {
    const r = await seriesRig({ settings: base059, startPrice: '0.058' });
    await r.engine.start();
    await r.sim.drain();
    // No book updates for 61 s; the runner keeps renewing the lease meanwhile.
    for (let t = 0; t < 61_000; t += 5000) { r.clock.advance(5000); await r.engine.renewLease(); }
    r.clock.advance(1000);
    await r.engine.tick();
    await r.sim.drain();
    expect(r.engine.getStatus()).toBe('PAUSED');
    expect(await r.sim.getOpenOrders()).toHaveLength(0);
    await r.step('0.058', 1000); // data flows again
    await r.engine.recover();
    await r.sim.drain();
    expect(r.engine.getStatus()).toBe('RUNNING');
    expect(await r.sim.getOpenOrders()).toHaveLength(15);
  });

  it('applies a duplicate fill exactly once', async () => {
    const r = await seriesRig({ settings: base059, startPrice: '0.058' });
    await r.engine.start();
    await r.sim.drain();
    await r.step('0.0620');
    const before = JSON.stringify(r.engine.getSlots());
    for (const f of r.sim.allFills) await r.engine.onFill(f);
    expect(JSON.stringify(r.engine.getSlots())).toBe(before);
    expect(r.engine.getStatus()).toBe('RUNNING');
  });

  it('recovers fills missed while the private feed was down, with no duplicate orders', async () => {
    const r = await seriesRig({ settings: base059, startPrice: '0.058' });
    await r.engine.start();
    await r.sim.drain();
    r.sim.dropPrivateFeed = true;
    await r.sim.moveTo(D('0.0625'));
    await r.sim.drain();
    expect(r.sim.allFills.length).toBeGreaterThan(0);
    r.sim.dropPrivateFeed = false;
    await r.engine.poll();
    await r.sim.drain();
    const open = await r.sim.getOpenOrders();
    expect(open).toHaveLength(15);
    expect(new Set(open.map((o) => o.clientOrderId)).size).toBe(15);
    expect(r.engine.getStatus()).toBe('RUNNING');
  });
});

describe('series resume after a restart', () => {
  it('keeps every loop and its profit, rebuilds balances, and re-places the orders', async () => {
    const { SeriesEngine } = await import('./engine');
    const { SimVenue } = await import('../engine/venue/sim-venue');
    const { MemoryLease } = await import('../engine/supervisor/lease');
    const { owed, reserveOf } = await import('./accounting');
    const { silentLogger } = await import('../engine/types');
    const r = await seriesRig({ settings: { ...base059, sellPct: '100' }, startPrice: '0.058' });
    await r.engine.start();
    await r.sim.drain();
    await r.step('0.0640'); // sells fill
    await r.step('0.0605'); // some buybacks fill
    const profitBefore = r.engine.getCycles().reduce((n, c) => n.plus(c.profit), D(0));
    expect(r.engine.getCycles().length).toBeGreaterThan(0);
    const run = (await r.store.latestRun('user-a', 'paper'))!;

    // "Restart": a fresh venue and engine built only from what the store kept.
    const slots = await r.store.loadSlots(run.id);
    const cycles = await r.store.listCycles(run.id);
    const residual = cycles.reduce((n, c) => n.plus(c.boughtNet).minus(c.soldQty), D(0));
    const zig = run.startZig.plus(residual).minus(slots.reduce((n, s) => n.plus(owed(s)), D(0)));
    const usdt = run.startUsdt.plus(slots.reduce((n, s) => n.plus(reserveOf(s)), D(0))).plus(cycles.reduce((n, c) => n.plus(c.profit), D(0)));
    const sim = new SimVenue({ specs: BYBIT_ZIG_SPECS, clock: r.clock, startPrice: D('0.0605'), startBase: zig, startQuote: usdt, idPrefix: 'after' });
    const plan = buildPlan(run.settings, D('0.0605'), BYBIT_ZIG_SPECS);
    const engine = new SeriesEngine({
      run, plan: { ...plan, basePrice: run.basePrice, qty: run.qty }, specs: BYBIT_ZIG_SPECS, venue: sim, store: r.store,
      lease: new MemoryLease(r.clock), leaseScope: 'user-a/paper', holder: 'restarted', clock: r.clock, log: silentLogger,
      alert: { send: async () => undefined }, symbol: 'ZIGUSDT', feedStaleSeconds: 60, leaseTtlSeconds: 15,
    });
    await sim.start({ onBook: (b) => engine.onBook(b), onFill: (f) => engine.onFill(f), onOrderUpdate: (u) => engine.onOrderUpdate(u), onFeedStatus: (f, c) => engine.onFeedStatus(f, c) });
    await engine.start({ slots, cycles });
    await sim.drain();
    await engine.idle();
    expect(engine.getStatus()).toBe('RUNNING');
    expect(engine.getCycles().reduce((n, c) => n.plus(c.profit), D(0)).eq(profitBefore)).toBe(true);
    expect(await sim.getOpenOrders()).toHaveLength(15);
    await engine.checkNow();
    expect(engine.snapshot().breaches).toEqual([]);
    // The loop goes on after the restart.
    await sim.moveTo(D('0.0580'));
    await sim.drain();
    await engine.idle();
    await sim.moveTo(D('0.0640'));
    await sim.drain();
    await engine.idle();
    expect(engine.getCycles().length).toBeGreaterThan(cycles.length);
    expect(engine.getStatus()).toBe('RUNNING');
  });
});

describe('buy-first series (the mirror)', () => {
  const buyFirst = { direction: 'BUY_FIRST' as const, totalZig: '0', startUsdt: '900', basePrice: '0.059' };
  const sellBackQty = (q: Decimal) => q.mul('0.999').toDecimalPlaces(2, Decimal.ROUND_DOWN);

  it('builds 15 buys going DOWN from base 0.059: first at -3%, then 1% apart, equal ZIG, funded by USDT', () => {
    const plan = buildPlan({ ...defaultSeriesSettings(), ...buyFirst, sellPct: '100' }, D('0.060'), BYBIT_ZIG_SPECS);
    expect(plan.direction).toBe('BUY_FIRST');
    expect(plan.orders.every((o) => o.side === 'BUY')).toBe(true);
    expect(plan.orders.slice(0, 6).map((o) => o.price.toFixed())).toEqual(['0.05723', '0.05666', '0.05609', '0.05553', '0.05497', '0.05442']);
    expect(plan.orders[0].price.lte(D('0.059').mul('0.97'))).toBe(true); // never closer than -3%
    const sum = plan.orders.reduce((n, o) => n.plus(o.price), D(0));
    expect(plan.qty.toFixed()).toBe(D(900).div(sum).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed());
    expect(plan.usdtForBuys.lte(900)).toBe(true);
    expect(plan.zigForSale.toFixed()).toBe('0');
  });

  it('refuses too little USDT and says how much is needed', () => {
    expect(() => buildPlan({ ...defaultSeriesSettings(), ...buyFirst, startUsdt: '30' }, D('0.06'), BYBIT_ZIG_SPECS)).toThrow(/USDT/);
  });

  it('6 buys fill -> 6 sell-backs 3% above; 3 sell-backs fill -> 3 re-buys 3% below; always 15 orders; profit in USDT', async () => {
    const r = await seriesRig({ settings: { ...buyFirst, sellPct: '100' }, startPrice: '0.0600' });
    await r.engine.start();
    await r.sim.drain();
    let open = await r.sim.getOpenOrders();
    expect(open).toHaveLength(15);
    expect(open.every((o) => o.side === 'BUY')).toBe(true);

    await r.step('0.0544'); // buys #1..#6 fill (0.05723 ... 0.05442)
    open = await r.sim.getOpenOrders();
    const sells = open.filter((o) => o.side === 'SELL').sort((a, b) => a.price.comparedTo(b.price));
    expect(open.filter((o) => o.side === 'BUY')).toHaveLength(9);
    expect(sells.map((o) => o.price.toFixed())).toEqual(['0.05606', '0.05662', '0.0572', '0.05778', '0.05836', '0.05895']);
    expect(open).toHaveLength(15);
    // Each sell-back sells exactly the ZIG received (Bybit keeps 0.1% of a buy in ZIG).
    const qty = r.engine.getSlots()[0].qty;
    expect(sells[0].qty.toFixed()).toBe(sellBackQty(qty).toFixed());

    await r.step('0.0575'); // sell-backs of #6, #5, #4 fill (0.05606, 0.05662, 0.0572)
    open = await r.sim.getOpenOrders();
    const rebuys = open.filter((o) => o.side === 'BUY' && /-C0002-/.test(o.clientOrderId)).map((o) => o.price.toFixed()).sort();
    expect(rebuys).toEqual(['0.05437', '0.05492', '0.05548']);
    expect(open).toHaveLength(15);
    const cycles = r.engine.getCycles();
    expect(cycles).toHaveLength(3);
    expect(cycles.every((c) => c.profit.gt(0))).toBe(true);
    expect(r.engine.getStatus()).toBe('RUNNING');
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
    // ZIG neutral: what was bought and sold back leaves the ZIG balance where it was, plus open buys.
    const bal = await r.sim.getBalances();
    const zigHeld = r.engine.getSlots().reduce((n, s) => n.plus(s.boughtNet.minus(s.soldQty)), D(0));
    expect(bal.base.toFixed()).toBe(zigHeld.plus(cycles.reduce((n, c) => n.plus(c.boughtNet).minus(c.soldQty), D(0))).toFixed());
  });

  it('keeps looping on a swinging market, and stop cancels every order', async () => {
    const r = await seriesRig({ settings: { ...buyFirst, sellPct: '100' }, startPrice: '0.0600' });
    await r.engine.start();
    await r.sim.drain();
    for (let i = 0; i < 5; i++) { await r.step('0.0530'); await r.step('0.0600'); }
    const slot1 = r.engine.getSlots().find((s) => s.slot === 1)!;
    expect(slot1.cycle).toBeGreaterThan(3);
    expect(r.engine.getCycles().length).toBeGreaterThan(20);
    expect(r.engine.getCycles().every((c) => c.profit.gt(0))).toBe(true);
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
    expect(await r.sim.getOpenOrders()).toHaveLength(15);
    await r.engine.stop();
    await r.sim.drain();
    expect(await r.sim.getOpenOrders()).toHaveLength(0);
    expect(r.engine.getStatus()).toBe('STOPPED');
  });

  it('a buy never rests above its price: with the market already below, it rests at the best bid', async () => {
    const r = await seriesRig({ settings: { ...buyFirst, sellPct: '100' }, startPrice: '0.0560' });
    await r.engine.start();
    await r.sim.drain();
    const open = await r.sim.getOpenOrders();
    expect(open).toHaveLength(15);
    const plan = buildPlan({ ...defaultSeriesSettings(), ...buyFirst, sellPct: '100' }, D('0.056'), BYBIT_ZIG_SPECS);
    for (const o of open) {
      const target = plan.orders.find((p) => o.clientOrderId.includes(`-N${String(p.slot).padStart(2, '0')}-`))!.price;
      expect(o.price.lte(target)).toBe(true);
    }
  });
});

describe('percentages with decimals', () => {
  it('accepts up to 2 decimals (1.5, 1.75, 1.9) and refuses more', () => {
    const s = { ...defaultSeriesSettings(), basePrice: '0.059', sellPct: '100', firstSellPct: '1.5', stepPct: '0.75', buybackPct: '1.75', resellPct: '1.9' };
    const plan = buildPlan(s, D('0.058'), BYBIT_ZIG_SPECS);
    expect(plan.orders[0].price.toFixed()).toBe('0.05989'); // 0.059 x 1.015, rounded up to the tick
    expect(() => buildPlan({ ...s, buybackPct: '1.755' }, D('0.058'), BYBIT_ZIG_SPECS)).toThrow(/2 decimals/);
  });
});

describe('daily reset (rebase)', () => {
  it('sell first: cancels everything incl. open buybacks, keeps profit, re-sizes from the ZIG held, ladder from the new base', async () => {
    const r = await seriesRig({ settings: { basePrice: '0.059', sellPct: '100', dailyReset: true }, startPrice: '0.058' });
    await r.engine.start();
    await r.sim.drain();
    await r.step('0.0640'); // sells #1..#6 fill
    await r.step('0.0605'); // buybacks #6..#4 fill: 3 loops closed, 3 buybacks still open
    const profit = r.engine.getCycles().reduce((n, c) => n.plus(c.profit), D(0));
    expect(r.engine.getCycles()).toHaveLength(3);
    const zigBefore = (await r.sim.getBalances()).base;

    const summary = await r.engine.rebase(D('0.0605'));
    await r.sim.drain();
    await r.engine.idle();
    expect(summary).not.toBeNull();
    expect(summary!.loopsClosedEarly).toBe(3); // the 3 open buybacks were dropped
    const open = await r.sim.getOpenOrders();
    expect(open).toHaveLength(15);
    expect(open.every((o) => o.side === 'SELL')).toBe(true);
    // New ladder: base 0.0605 +3% = 0.06232, then +1% each, sized from the ZIG the account holds now.
    const prices = open.map((o) => o.price.toFixed()).sort();
    expect(prices[0]).toBe('0.06232');
    const qty = zigBefore.div(15).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    expect(open.every((o) => o.qty.eq(qty))).toBe(true);
    // Same series: profit and loops are untouched, nothing is ever reused as an order ID.
    expect(r.engine.getCycles().reduce((n, c) => n.plus(c.profit), D(0)).eq(profit)).toBe(true);
    expect(new Set(open.map((o) => o.clientOrderId)).size).toBe(15);
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
    // And it keeps looping after the reset.
    await r.step('0.0660');
    await r.step('0.0600');
    expect(r.engine.getCycles().length).toBeGreaterThan(3);
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
    expect(r.engine.getStatus()).toBe('RUNNING');
  });

  it('buy first: new buys below the new base, sized from the USDT held; balances still reconcile', async () => {
    const r = await seriesRig({ settings: { direction: 'BUY_FIRST', totalZig: '0', startUsdt: '900', basePrice: '0.059', sellPct: '100', dailyReset: true }, startPrice: '0.0600' });
    await r.engine.start();
    await r.sim.drain();
    await r.step('0.0544'); // 6 buys fill
    await r.step('0.0575'); // 3 sell-backs fill
    expect(r.engine.getCycles()).toHaveLength(3);
    const summary = await r.engine.rebase(D('0.0575'));
    await r.sim.drain();
    await r.engine.idle();
    expect(summary!.loopsClosedEarly).toBe(3); // 3 bought, not yet sold back: that ZIG is kept
    expect(Number(summary!.zigLeftBought)).toBeGreaterThan(0);
    const open = await r.sim.getOpenOrders();
    expect(open).toHaveLength(15);
    expect(open.every((o) => o.side === 'BUY')).toBe(true);
    expect(open.map((o) => o.price.toFixed()).sort().reverse()[0]).toBe('0.05577'); // 0.0575 -3%, rounded down
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
    await r.step('0.0530');
    await r.step('0.0580');
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
    expect(r.engine.getStatus()).toBe('RUNNING');
  });
});

describe('daily reset time', () => {
  it('is 00:00 Pakistan time, which is 19:00 UTC', async () => {
    const { lastResetBoundary } = await import('../engine-api/series.service');
    expect(new Date(lastResetBoundary(Date.parse('2026-10-17T18:59:59Z'))).toISOString()).toBe('2026-10-16T19:00:00.000Z');
    expect(new Date(lastResetBoundary(Date.parse('2026-10-17T19:00:00Z'))).toISOString()).toBe('2026-10-17T19:00:00.000Z');
    expect(new Date(lastResetBoundary(Date.parse('2026-10-18T03:00:00Z'))).toISOString()).toBe('2026-10-17T19:00:00.000Z');
  });
});

describe('BTC/USDT: same rules as ZIG', () => {
  it('builds the BTC ladder with BTC precision: +3% then +1%, equal BTC per order', async () => {
    const { BYBIT_BTC_SPECS } = await import('./testing');
    const plan = buildPlan({ ...defaultSeriesSettings(), symbol: 'BTCUSDT', totalZig: '0.1', sellPct: '100', basePrice: '80000' }, D('80000'), BYBIT_BTC_SPECS);
    expect(plan.qty.toFixed()).toBe('0.006666'); // 0.1 / 15, down to 0.000001 BTC
    expect(plan.orders.slice(0, 3).map((o) => o.price.toFixed())).toEqual(['82400', '83224', '84056.2']);
    expect(() => buildPlan({ ...defaultSeriesSettings(), symbol: 'BTCUSDT', totalZig: '0.0005', sellPct: '100', basePrice: '80000' }, D('80000'), BYBIT_BTC_SPECS))
      .toThrow(/BTC/);
  });

  it('runs the full loop on BTC: sells fill, buybacks 3% below, profit in USDT, balances reconcile', async () => {
    const { BYBIT_BTC_SPECS } = await import('./testing');
    const r = await seriesRig({
      symbol: 'BTCUSDT', specs: BYBIT_BTC_SPECS, startPrice: '80000',
      settings: { symbol: 'BTCUSDT', totalZig: '0.1', sellPct: '100', basePrice: '80000' },
    });
    await r.engine.start();
    await r.sim.drain();
    expect(await r.sim.getOpenOrders()).toHaveLength(15);
    expect((await r.sim.getOpenOrders()).every((o) => o.clientOrderId.startsWith('BTCUSDT-'))).toBe(true);
    await r.step('86000'); // the lower sells fill
    const buys = (await r.sim.getOpenOrders()).filter((o) => o.side === 'BUY').sort((a, b) => a.price.comparedTo(b.price));
    expect(buys[0].price.toFixed()).toBe('79928'); // 82400 x 0.97, rounded down to 0.1
    await r.step('79000'); // every buyback fills
    expect(r.engine.getCycles().length).toBeGreaterThan(3);
    expect(r.engine.getCycles().every((c) => c.profit.gt(0))).toBe(true);
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]);
    expect(await r.sim.getOpenOrders()).toHaveLength(15);
  });
});

describe('copying a ladder to another exchange', () => {
  it('keeps the exact prices on a finer tick and rounds away from the base on a coarser one', () => {
    const mexcZig = { ...BYBIT_ZIG_SPECS, tick: D('0.000001'), minOrderValue: D(1), makerFee: D(0) };
    const s = { ...defaultSeriesSettings(), sellPct: '100', basePrice: '0.04798', firstSellPct: '0.5', stepPct: '0.25' };
    const bybit = buildPlan(s, D('0.048'), BYBIT_ZIG_SPECS);
    const copy = buildPlan({ ...s, ladder: bybit.orders.map((o) => o.price.toFixed()) }, D('0.048'), mexcZig);
    expect(copy.orders.map((o) => o.price.toFixed())).toEqual(bybit.orders.map((o) => o.price.toFixed()));
    expect(copy.qty.toFixed()).toBe(bybit.qty.toFixed());
    // MEXC -> Bybit: a sell is rounded up, never placed below the copied price.
    const back = buildPlan({ ...s, ladder: ['0.048221', '0.048342'], orders: 2 }, D('0.048'), BYBIT_ZIG_SPECS);
    expect(back.orders.map((o) => o.price.toFixed())).toEqual(['0.04823', '0.04835']);
  });
});
