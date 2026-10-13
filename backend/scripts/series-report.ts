import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { candlesFor } from '../src/engine/backtest/candles';
import { BYBIT_ZIG_SPECS } from '../src/engine/testing';
import { runSeriesBacktest } from '../src/series/backtest';
import { defaultSeriesSettings } from '../src/series/plan';

/** Runs the standard Series scenarios on the cached 30-day Bybit candles and saves one JSON for the report page. */
async function main() {
  const all = await candlesFor('ZIGUSDT', 30, join('engine-data', 'ZIGUSDT-1m-30d.csv'));
  const lastDays = (n: number) => all.filter((c) => c.start >= all[all.length - 1].start - n * 86_400_000);
  const d = defaultSeriesSettings();
  const scenarios = [
    { id: '7d', label: 'Last 7 days, base 0.059', settings: { ...d, basePrice: '0.059' }, candles: lastDays(7) },
    { id: '7d-plus1', label: 'Last 7 days, base 0.059, first sell +1%', settings: { ...d, basePrice: '0.059', firstSellPct: '1' }, candles: lastDays(7) },
    { id: '1d', label: 'Last 24 hours, base 0.059', settings: { ...d, basePrice: '0.059' }, candles: lastDays(1) },
    { id: '30d', label: '30 days, base = market at start (17,000 ZIG)', settings: { ...d, totalZig: '17000' }, candles: all },
  ];
  const out: unknown[] = [];
  for (const s of scenarios) {
    const r = await runSeriesBacktest({ label: s.label, settings: s.settings, specs: BYBIT_ZIG_SPECS, candles: s.candles });
    console.log(`${s.id}: ${r.cyclesCompleted} loops, $${r.realisedProfitUsd}, ${r.ordersPlaced} orders`);
    out.push({ id: s.id, settings: s.settings, report: r });
  }
  mkdirSync('engine-data', { recursive: true });
  writeFileSync(join('engine-data', 'series-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: out }));
}
main().catch((e) => { console.error(e); process.exit(1); });
