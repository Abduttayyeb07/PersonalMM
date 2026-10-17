import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { candlesFor } from '../src/engine/backtest/candles';
import { BYBIT_ZIG_SPECS } from '../src/engine/testing';
import { runSeriesBacktest, SeriesBacktestReport } from '../src/series/backtest';
import { defaultSeriesSettings } from '../src/series/plan';
import { SeriesSettings } from '../src/series/types';

/**
 * Replays real Bybit ZIGUSDT 1-minute candles through the series engine.
 *
 *   npm run series-backtest -- [--days 30] [--refresh] [--zig 15000] [--base 0.059] [--last-days 1]
 *
 * Without --base the series starts with the base at the first candle's price (the default in the app).
 */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function print(r: SeriesBacktestReport) {
  const buy = r.direction === 'BUY_FIRST';
  const open = buy ? 'buys' : 'sells';
  const close = buy ? 'sell-backs' : 'buybacks';
  const out = Number(r.zigStillSold);
  const rows: Array<[string, string | number]> = [
    ['Period', `${r.from.slice(0, 16)} -> ${r.to.slice(0, 16)} (${r.days} days, ${r.candles} candles)`],
    ['Price', `start ${r.startPrice}, end ${r.endPrice}, low ${r.lowPrice}, high ${r.highPrice}`],
    [`Base / ${open}`, `base ${r.basePrice}: ${open} ${r.firstSell} ... ${r.lastSell}, ${r.qtyPerOrder} ZIG each`],
    ['Orders placed', `${r.ordersPlaced} (rejected ${r.ordersRejected}): ${r.placedByKind.firstSells} first ${open}, ${r.placedByKind.buybacks} ${close}, ${r.placedByKind.resells} re-${open}`],
    ['Fills', `${r.sellFills} sell, ${r.buyFills} buy (${r.sellFills + r.buyFills} total)`],
    [`${buy ? 'Buys' : 'Sells'} completed`, r.sellsCompleted],
    ['Loops completed', `${r.cyclesCompleted} (${r.cyclesPerDay}/day)`],
    ['Realised profit', `$${r.realisedProfitUsd} (fees paid $${r.feesPaidUsd})`],
    ['Open at end', `${buy ? r.openBuysEnd : r.openSellsEnd} ${open}, ${buy ? r.openSellsEnd : r.openBuysEnd} ${close}`],
    [buy ? 'ZIG bought, open' : 'ZIG still sold', `${Math.abs(out)} (max ${r.maxZigSold})`],
    ['Account vs hold', `MtM $${r.markToMarketUsd} vs just holding $${r.holdUsd}`],
    ['Daily resets', r.resets],
    ['Status', `${r.status}${r.statusReason ? ` (${r.statusReason})` : ''}`],
    ['Loops by order', Object.entries(r.cyclesBySlot).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'],
  ];
  console.log(`\n=== ${r.label} ===`);
  for (const [k, v] of rows) console.log(`${k.padEnd(17)} ${v}`);
  if (r.profitByDay.length) {
    console.log('Per day          ' + r.profitByDay.map((d) => `${d.day.slice(5)}: ${d.cycles} / $${d.profit}`).join(', '));
  }
}

async function main() {
  const days = Number(arg('days', '30'));
  let candles = await candlesFor('ZIGUSDT', days, join('engine-data', `ZIGUSDT-1m-${days}d.csv`), flag('refresh'));
  const lastDays = arg('last-days');
  if (lastDays) candles = candles.filter((c) => c.start >= candles[candles.length - 1].start - Number(lastDays) * 86_400_000);
  const buyFirst = arg('direction', 'sell') === 'buy';
  const base: SeriesSettings = {
    ...defaultSeriesSettings(),
    direction: buyFirst ? 'BUY_FIRST' : 'SELL_FIRST',
    totalZig: arg('zig', buyFirst ? '0' : '15000')!,
    startUsdt: arg('usdt', buyFirst ? '900' : '0')!,
    sellPct: arg('pct', '10')!,
    basePrice: arg('base') ?? null,
    dailyReset: flag('daily-reset'),
  };
  const variants: Array<{ label: string; settings: SeriesSettings }> = [
    { label: `Series ${buyFirst ? 'buy-first' : 'sell-first'} (${buyFirst ? `${base.startUsdt} USDT` : `${base.totalZig} ZIG`}, ${base.sellPct}% in ${base.orders} ${buyFirst ? 'buys' : 'sells'}, ${buyFirst ? `-${base.firstSellPct}% / -${base.stepPct}% / +${base.resellPct}% sell-back / -${base.buybackPct}% re-buy` : `+${base.firstSellPct}% / +${base.stepPct}% / -${base.buybackPct}% buyback / +${base.resellPct}% re-sell`})`, settings: base },
  ];
  if (flag('compare-reset')) variants.push({ label: `${variants[0].label} + daily reset`, settings: { ...base, dailyReset: true } });
  if (flag('compare')) {
    variants.push({ label: 'buyback/re-sell 2%', settings: { ...base, buybackPct: '2', resellPct: '2' } });
    variants.push({ label: 'first sell +1%', settings: { ...base, firstSellPct: '1' } });
  }
  const reports: SeriesBacktestReport[] = [];
  for (const v of variants) {
    const r = await runSeriesBacktest({ label: v.label, settings: v.settings, specs: BYBIT_ZIG_SPECS, candles });
    print(r);
    reports.push(r);
  }
  mkdirSync('engine-data', { recursive: true });
  const out = join('engine-data', `series-backtest-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify(reports, null, 2));
  console.log(`\nSaved ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
