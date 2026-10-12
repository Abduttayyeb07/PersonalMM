import Decimal from 'decimal.js';
import { PairConfig, SharedConfig } from '../config/engine-config';
import { EngineInstance } from '../engine-instance';
import { buybackQty, owed } from '../rung-accounting';
import { MemoryLedger } from '../ledger/memory-ledger';
import { MemoryLease } from '../supervisor/lease';
import { FakeClock, CapturingAlerter, makeEngine } from '../testing';
import { VenueSpecs } from '../types';
import { SimVenue } from '../venue/sim-venue';
import { Candle } from './candles';

export interface BacktestReport {
  label: string;
  step: string;
  ladders: number;
  rungSize: string;
  from: string;
  to: string;
  candles: number;
  startPrice: string;
  endPrice: string;
  cyclesCompleted: number;
  cyclesPerWeek: number;
  realisedProfitUsd: string;
  feesPaidUsd: string;
  /** Largest deviation between a cycle's booked profit and the spec formula for that cycle. */
  maxFormulaDeviationUsd: string;
  baseOwedEnd: string;
  /** Base gained to lot rounding of buybacks (rounded up so a cycle never returns less). */
  baseRoundingResidual: string;
  maxBaseOwed: string;
  reserveEnd: string;
  /** Base valued at the final price + quote, minus the same at the start. */
  markToMarketUsd: string;
  /** What simply holding the starting base would have made over the same period. */
  holdUsd: string;
  status: string;
  statusReason?: string;
  selfCrossRejections: number;
  netted: number;
  kills: number;
  cyclesByRung: Record<string, number>;
}

/**
 * Replays candles through the exact engine code against the simulated venue. Within each minute the
 * price visits open -> low -> high -> close (or open -> high -> low -> close on a down candle).
 */
export async function runBacktest(opts: {
  label: string; cfg: PairConfig; shared: SharedConfig; specs: VenueSpecs; candles: Candle[];
  startBase: Decimal; startQuote?: Decimal; spreadTicks?: number;
  /** Called with the finished run, e.g. to publish it to the dashboard. */
  onFinish?: (run: { ledger: MemoryLedger; scope: string; engine: EngineInstance }) => Promise<void>;
}): Promise<BacktestReport> {
  const { cfg, shared, specs, candles } = opts;
  if (!candles.length) throw new Error('no candles');
  const clock = new FakeClock(candles[0].start);
  const ledger = new MemoryLedger();
  const lease = new MemoryLease(clock);
  const alerts = new CapturingAlerter();
  const startPrice = candles[0].open;
  const sim = new SimVenue({
    specs, clock, startBase: opts.startBase, startQuote: opts.startQuote ?? new Decimal(0), startPrice, spreadTicks: opts.spreadTicks ?? 1,
  });
  // The lease is exercised by the drills, not here: one candle step must not expire it.
  const btShared = { ...shared, leaseTtlSeconds: 3600 };
  const engine: EngineInstance = makeEngine({ cfg, shared: btShared, specs, sim, ledger, lease, clock, alerts, holder: 'backtest', ownerId: 'backtest' });
  await sim.start({
    onBook: (b) => engine.onBook(b), onFill: (f) => engine.onFill(f),
    onOrderUpdate: (u) => engine.onOrderUpdate(u), onFeedStatus: (feed, c) => engine.onFeedStatus(feed, c),
  });
  await engine.initGenesis();
  await engine.start();
  await sim.drain();

  let maxOwed = new Decimal(0);
  for (const c of candles) {
    if (engine.getStatus() !== 'RUNNING') break;
    const path = c.close.gte(c.open) ? [c.open, c.low, c.high, c.close] : [c.open, c.high, c.low, c.close];
    for (let i = 0; i < path.length; i++) {
      clock.set(c.start + i * 15_000);
      await engine.renewLease();
      await sim.moveTo(path[i]);
      await engine.tick();
      await sim.drain();
      await engine.idle();
    }
    const o = engine.getRungs().reduce((s, r) => s.plus(owed(r)), new Decimal(0));
    if (o.gt(maxOwed)) maxOwed = o;
    if ((c.start / 60_000) % 60 === 0) await engine.checkNow('hourly');
  }
  await engine.checkNow('final');
  if (opts.onFinish) await opts.onFinish({ ledger, scope: engine.pairId, engine });

  const cycles = engine.getCycles();
  const last = candles[candles.length - 1];
  const balances = await sim.getBalances();
  const endPrice = last.close;
  const startValue = opts.startBase.mul(startPrice).plus(opts.startQuote ?? 0);
  const endValue = balances.base.mul(endPrice).plus(balances.quote);
  const rungByKey = new Map(engine.lattice.map((r) => [r.key, r]));
  let maxDev = new Decimal(0);
  let fees = new Decimal(0);
  const byRung: Record<string, number> = {};
  for (const cy of cycles) {
    byRung[cy.rungKey] = (byRung[cy.rungKey] ?? 0) + 1;
    fees = fees.plus(cy.feeSellQuote).plus(cy.feeBuyQuote).plus(cy.feeBuyBase.mul(cy.avgBuy));
    const r = rungByKey.get(cy.rungKey);
    if (!r || cy.netted) continue;
    // Spec formula on the venue's fee mechanics: proceeds net of the sell fee minus the gross-up buy.
    const expected = cy.soldQty.mul(cy.avgSell).mul(new Decimal(1).minus(specs.makerFee))
      .minus(buybackQty(cy.soldQty, specs).mul(cy.avgBuy));
    const dev = cy.profit.minus(expected).abs();
    if (dev.gt(maxDev)) maxDev = dev;
  }
  const days = (last.start - candles[0].start) / 86_400_000 || 1;
  const snap = engine.snapshot();
  const killLog = ledger.auditLog.filter((e) => e.kind === 'KILL');
  return {
    label: opts.label,
    step: cfg.step.toFixed(),
    ladders: cfg.ladders.length,
    rungSize: cfg.rungSizeBase.toFixed(),
    from: new Date(candles[0].start).toISOString(),
    to: new Date(last.start).toISOString(),
    candles: candles.length,
    startPrice: startPrice.toFixed(),
    endPrice: endPrice.toFixed(),
    cyclesCompleted: cycles.length,
    cyclesPerWeek: Math.round((cycles.length / days) * 7 * 10) / 10,
    realisedProfitUsd: cycles.reduce((s, c) => s.plus(c.profit), new Decimal(0)).toFixed(2),
    feesPaidUsd: fees.toFixed(2),
    maxFormulaDeviationUsd: maxDev.toFixed(6),
    baseOwedEnd: snap.baseOwed,
    baseRoundingResidual: cycles.reduce((s, c) => s.plus(c.boughtNet).minus(c.soldQty), new Decimal(0)).toFixed(),
    maxBaseOwed: maxOwed.toFixed(),
    reserveEnd: new Decimal(snap.reserve).toFixed(2),
    markToMarketUsd: endValue.minus(startValue).toFixed(2),
    holdUsd: opts.startBase.mul(endPrice.minus(startPrice)).toFixed(2),
    status: engine.getStatus(),
    statusReason: snap.statusReason,
    selfCrossRejections: ledger.auditLog.filter((e) => e.kind === 'KILL' && String(e.detail.reason).includes('SELF_CROSS')).length,
    netted: ledger.auditLog.filter((e) => e.kind === 'NETTED').length,
    kills: killLog.length,
    cyclesByRung: byRung,
  };
}

export function formatReport(reports: BacktestReport[]): string {
  const rows = reports.map((r) => [
    r.label, `${(Number(r.step) * 100).toFixed(1)}%`, r.ladders, r.rungSize, r.cyclesCompleted, r.cyclesPerWeek,
    `$${r.realisedProfitUsd}`, `$${r.feesPaidUsd}`, r.maxBaseOwed, r.baseOwedEnd, `$${r.markToMarketUsd}`, `$${r.holdUsd}`,
    r.status, r.kills, r.netted, r.maxFormulaDeviationUsd, r.baseRoundingResidual,
  ].join(' | '));
  const head = 'config | step | ladders | rung | cycles | /week | realised | fees | max owed | owed end | MtM P&L | hold P&L | status | kills | netted | max formula dev | base residual';
  const r0 = reports[0];
  return [
    `Backtest ${r0.from} -> ${r0.to} (${r0.candles} one-minute candles), price ${r0.startPrice} -> ${r0.endPrice}`,
    '',
    `| ${head} |`,
    `|${head.split('|').map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}
