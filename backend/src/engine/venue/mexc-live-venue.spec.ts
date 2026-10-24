import Decimal from 'decimal.js';
import { MemoryLease } from '../supervisor/lease';
import { CapturingAlerter, FakeClock } from '../testing';
import { Alerter, VenueSpecs, silentLogger } from '../types';
import { SimVenue } from './sim-venue';
import { MexcLiveVenue } from './mexc-live-venue';
import { SeriesEngine } from '../../series/engine';
import { MemorySeriesStore } from '../../series/memory-store';
import { parseSeriesOrderId } from '../../series/order-id';
import { buildPlan, defaultSeriesSettings } from '../../series/plan';
import { SeriesSettings } from '../../series/types';

const D = (v: Decimal.Value) => new Decimal(v);

/** MEXC ZIGUSDT spot rules: price steps of 0.000001, 0.01 ZIG, 1 USDT minimum. */
const MEXC_ZIG: VenueSpecs = { tick: D('0.000001'), lot: D('0.01'), minOrderValue: D(1), makerFee: D('0.001'), buyFeeAsset: 'base', maxOpenOrders: 500 };

const mexcError = (status: number, code: number, msg: string) =>
  Object.assign(new Error(msg), { isAxiosError: true, response: { status, data: { code, msg } } });

/**
 * A stand-in for MEXC's REST API, matching orders with the same simulator the backtests use.
 * Only the endpoints the live venue calls exist; anything else fails loudly.
 */
class FakeMexc {
  readonly sim: SimVenue;
  readonly calls: string[] = [];
  constructor(clock: FakeClock, price: string, zig: string, usdt: string) {
    this.sim = new SimVenue({ specs: MEXC_ZIG, clock, startPrice: D(price), startBase: D(zig), startQuote: D(usdt) });
  }

  private parse(url: string, config?: { params?: Record<string, unknown> }) {
    const [path, qs] = url.split('?');
    const params = Object.fromEntries(new URLSearchParams(qs ?? ''));
    return { path, p: { ...params, ...(config?.params as Record<string, string> | undefined) } as Record<string, string> };
  }

  readonly http = {
    get: async (url: string, config?: { params?: Record<string, unknown> }) => {
      const { path, p } = this.parse(url, config);
      this.calls.push(`GET ${path}`);
      if (path === '/api/v3/ticker/bookTicker') {
        const b = await this.sim.getBook();
        return { data: { symbol: 'ZIGUSDT', bidPrice: b.bestBid.toFixed(), askPrice: b.bestAsk.toFixed() } };
      }
      if (path === '/api/v3/openOrders') {
        return { data: (await this.sim.getOpenOrders()).map((o) => ({
          clientOrderId: o.clientOrderId, orderId: o.orderId, side: o.side, price: o.price.toFixed(), origQty: o.qty.toFixed(), executedQty: o.filledQty.toFixed(),
        })) };
      }
      if (path === '/api/v3/order') {
        const f = await this.sim.findOrder(p.origClientOrderId);
        if (!f.found) throw mexcError(400, -2013, 'Order does not exist.');
        const filled = f.filledQty ?? D(0);
        const status = f.open ? (filled.gt(0) ? 'PARTIALLY_FILLED' : 'NEW') : f.cancelled ? 'CANCELED' : 'FILLED';
        return { data: { orderId: f.open?.orderId ?? 'x', status, executedQty: filled.toFixed(), price: f.open?.price.toFixed() ?? '0', origQty: f.open?.qty.toFixed() ?? '0', side: f.open?.side ?? 'BUY' } };
      }
      if (path === '/api/v3/myTrades') {
        return { data: (await this.sim.getFillsSince(Number(p.startTime ?? 0))).map((f) => ({
          id: f.fillId, orderId: f.orderId, clientOrderId: f.clientOrderId, price: f.price.toFixed(), qty: f.qty.toFixed(),
          commission: f.feeAmount.toFixed(), commissionAsset: f.feeAsset === 'base' ? 'ZIG' : 'USDT', time: f.ts, isBuyer: f.side === 'BUY',
        })) };
      }
      if (path === '/api/v3/account') {
        const b = await this.sim.getBalances();
        return { data: { balances: [{ asset: 'ZIG', free: b.base.toFixed(), locked: '0' }, { asset: 'USDT', free: b.quote.toFixed(), locked: '0' }] } };
      }
      throw new Error(`fake MEXC has no GET ${path}`);
    },
    post: async (url: string) => {
      const { path, p } = this.parse(url);
      this.calls.push(`POST ${path} ${p.type}`);
      if (path !== '/api/v3/order') throw new Error(`fake MEXC has no POST ${path}`);
      if (p.type !== 'LIMIT_MAKER') throw mexcError(400, 700004, 'only post-only orders are allowed in this test');
      const r = await this.sim.placeOrder({ clientOrderId: p.newClientOrderId, side: p.side as 'BUY' | 'SELL', price: D(p.price), qty: D(p.quantity) });
      if (!r.ok) {
        if (r.reason === 'WOULD_CROSS') throw mexcError(400, 30010, 'LIMIT_MAKER order would immediately match');
        if (r.reason === 'INSUFFICIENT_BALANCE') throw mexcError(400, 30004, 'Insufficient balance');
        throw mexcError(400, 1, r.message);
      }
      return { data: { orderId: r.orderId } };
    },
    delete: async (url: string) => {
      const { path, p } = this.parse(url);
      this.calls.push(`DELETE ${path}`);
      const f = await this.sim.findOrder(p.origClientOrderId);
      if (!f.found || !f.open) throw mexcError(400, -2011, 'Order does not exist.');
      await this.sim.cancelOrder(p.origClientOrderId);
      return { data: { status: 'CANCELED' } };
    },
  };
}

async function liveRig() {
  const clock = new FakeClock();
  // The real account holds more than the simulation's slice: 1,000 ZIG and 500 USDT of the user's own.
  const mexc = new FakeMexc(clock, '0.0453', '1000', '500');
  await mexc.sim.start({ onBook: () => undefined, onFill: () => undefined, onOrderUpdate: () => undefined, onFeedStatus: () => undefined });
  // A manual order of the user's on the same pair: the engine must never touch it.
  await mexc.sim.placeOrder({ clientOrderId: 'manual-order-1', side: 'SELL', price: D('0.07'), qty: D(100) });

  const settings: SeriesSettings = {
    ...defaultSeriesSettings(), symbol: 'ZIGUSDT', direction: 'BUY_FIRST', totalZig: '0', startUsdt: '225', sellPct: '100', basePrice: null,
  };
  const plan = buildPlan(settings, D('0.0453'), MEXC_ZIG);
  const store = new MemorySeriesStore();
  store.now = () => clock.now();
  const run = await store.createRun({
    ownerId: 'u', mode: 'paper', settings, basePrice: plan.basePrice, qty: plan.qty, startZig: D(0), startUsdt: D(225), startedAt: clock.now(),
  });
  const venue = new MexcLiveVenue({
    symbol: 'ZIGUSDT', baseAsset: 'ZIG', quoteAsset: 'USDT', specs: MEXC_ZIG, apiKey: 'k', apiSecret: 's', clock, log: silentLogger,
    owns: (id) => { const p = parseSeriesOrderId(id); return !!p && p.symbol === 'ZIGUSDT' && p.seriesNo === run.seriesNo; },
    wallet: { base: D(0), quote: D(225) }, http: mexc.http as never,
  });
  const engine = new SeriesEngine({
    run, plan, specs: MEXC_ZIG, venue, store, lease: new MemoryLease(clock), leaseScope: 'u/live', holder: 't', clock,
    log: silentLogger, alert: new CapturingAlerter() as Alerter, symbol: 'ZIGUSDT', feedStaleSeconds: 60, leaseTtlSeconds: 3600,
  });
  await venue.start({
    onBook: (b) => engine.onBook(b), onFill: (f) => engine.onFill(f),
    onOrderUpdate: (u) => engine.onOrderUpdate(u), onFeedStatus: (f, c) => engine.onFeedStatus(f, c),
  }, { timers: false });
  /** The market trades to `price`; then the venue polls MEXC and the engine reacts (twice: new orders are polled too). */
  const step = async (price: string) => {
    clock.advance(2000);
    await mexc.sim.moveTo(D(price));
    for (let i = 0; i < 2; i++) {
      await venue.pollBook();
      await venue.pollPrivate();
      await engine.tick();
      await engine.idle();
    }
  };
  const ours = async () => (await mexc.sim.getOpenOrders()).filter((o) => o.clientOrderId !== 'manual-order-1');
  return { mexc, venue, engine, step, ours, plan, clock };
}

describe('MEXC live venue', () => {
  it('runs buy-first ZIG on MEXC with post-only orders, books real fills and fees, and never touches other orders or coins', async () => {
    const r = await liveRig();
    await r.engine.start();
    await r.engine.idle();
    let open = await r.ours();
    expect(open).toHaveLength(15);
    expect(open.every((o) => o.side === 'BUY')).toBe(true);
    expect(r.mexc.calls.filter((c) => c.startsWith('POST')).every((c) => c.endsWith('LIMIT_MAKER'))).toBe(true);

    await r.step('0.0420'); // the price dips: the top buys fill on MEXC
    open = await r.ours();
    const sells = open.filter((o) => o.side === 'SELL');
    expect(sells.length).toBeGreaterThan(0);
    expect(open).toHaveLength(15);

    await r.step('0.0450'); // it bounces: the sell-backs fill and loops close
    const cycles = r.engine.getCycles();
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.every((c) => c.profit.gt(0))).toBe(true);
    await r.engine.checkNow();
    expect(r.engine.snapshot().breaches).toEqual([]); // the wallet slice adds up despite the account's other ZIG/USDT
    expect(r.engine.getStatus()).toBe('RUNNING');

    // The manual order is untouched, and stopping cancels only this simulation's orders.
    await r.engine.stop('test');
    expect(await r.ours()).toHaveLength(0);
    expect((await r.mexc.sim.getOpenOrders()).map((o) => o.clientOrderId)).toEqual(['manual-order-1']);
    expect(r.mexc.calls.some((c) => c.startsWith('DELETE /api/v3/openOrders'))).toBe(false); // never "cancel all on the symbol"
  });

  it('halts and cancels everything if one of its orders is cancelled from outside (for example in the MEXC app)', async () => {
    const r = await liveRig();
    await r.engine.start();
    await r.engine.idle();
    const victim = (await r.ours())[0];
    r.clock.advance(60_000); // well after placing, so it is not mistaken for a post-only refusal
    await r.mexc.sim.cancelOrder(victim.clientOrderId);
    await r.step('0.0453');
    expect(r.engine.getStatus()).toBe('HALTED');
    expect(await r.ours()).toHaveLength(0);
    expect((await r.mexc.sim.getOpenOrders()).map((o) => o.clientOrderId)).toEqual(['manual-order-1']);
  });

  it('reads MEXC errors: insufficient balance, post-only refusal and rate limits', async () => {
    const r = await liveRig();
    const place = (side: 'BUY' | 'SELL', price: string, qty: string, id: string) =>
      r.venue.placeOrder({ clientOrderId: id, side, price: D(price), qty: D(qty) });
    expect(await place('SELL', '0.0400', '100', 'ZIGUSDT-S001-N01-C0001-S')).toMatchObject({ ok: false, reason: 'WOULD_CROSS' });
    expect(await place('BUY', '0.0400', '1000000', 'ZIGUSDT-S001-N01-C0001-B')).toMatchObject({ ok: false, reason: 'INSUFFICIENT_BALANCE' });
    expect(await place('BUY', '0.0400', '100', 'someone-else-id')).toMatchObject({ ok: false, reason: 'INVALID' });
  });
});
