import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { MarketVenue, marketCandles, marketSpecs } from '../src/engine/venue/markets';
import { appDefaults } from '../src/engine-api/series.service';
import { runSeriesBacktest } from '../src/series/backtest';
import { SeriesDirection, SeriesSymbol } from '../src/series/types';

/**
 * Tries a grid of percentages for one pair and both directions on real Bybit 1-minute candles, to find
 * the settings to run. The first `train` days pick the settings; the days after them check that the
 * pick still works on prices it has not seen.
 *
 *   npx ts-node scripts/series-grid.ts --symbol SOLUSDT [--days 30] [--train 23]
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const FIRST = ['0.5', '1', '2', '3'];
const STEP = ['0.25', '0.5', '1'];
const LOOP = ['0.75', '1', '1.5', '2', '3'];
const RESET = [false, true];

async function main() {
  const symbol = arg('symbol', 'SOLUSDT') as SeriesSymbol;
  const days = Number(arg('days', '30'));
  const train = Number(arg('train', '23'));
  const venue = arg('venue', 'BYBIT') as MarketVenue;
  const specs = await marketSpecs(venue, symbol);
  const tag = venue === 'BYBIT' ? symbol : `${symbol}-${venue}`;
  const candles = await marketCandles(venue, symbol, days, join('engine-data', `${tag}-1m-${days}d.csv`));
  const split = candles[0].start + train * 86_400_000;
  const trainC = candles.filter((c) => c.start < split);
  const testC = candles.filter((c) => c.start >= split);
  const out: unknown[] = [];
  for (const direction of ['SELL_FIRST', 'BUY_FIRST'] as SeriesDirection[]) {
    const base = { ...appDefaults(symbol, direction), venue };
    for (const firstSellPct of FIRST) for (const stepPct of STEP) for (const loop of LOOP) for (const dailyReset of RESET) {
      const settings = { ...base, firstSellPct, stepPct, buybackPct: loop, resellPct: loop, dailyReset, basePrice: null };
      const row: Record<string, unknown> = { symbol, direction, firstSellPct, stepPct, loopPct: loop, dailyReset };
      for (const [name, set] of [['train', trainC], ['test', testC], ['all', candles]] as const) {
        try {
          const r = await runSeriesBacktest({ label: name, settings, specs, candles: set });
          row[name] = {
            loops: r.cyclesCompleted, profit: Number(r.realisedProfitUsd), mtm: Number(r.markToMarketUsd), hold: Number(r.holdUsd),
            fees: Number(r.feesPaidUsd), stuck: Math.abs(Number(r.zigStillSold)), status: r.status,
          };
        } catch (e) {
          row[name] = { error: (e as Error).message };
        }
      }
      out.push(row);
    }
    process.stdout.write(`${symbol} ${direction} done\n`);
  }
  mkdirSync(join('engine-data', 'grid'), { recursive: true });
  writeFileSync(join('engine-data', 'grid', `${tag}.json`), JSON.stringify({
    symbol: tag, from: new Date(candles[0].start).toISOString(), to: new Date(candles[candles.length - 1].start).toISOString(),
    split: new Date(split).toISOString(), low: Math.min(...candles.map((c) => c.low.toNumber())), high: Math.max(...candles.map((c) => c.high.toNumber())),
    start: candles[0].open.toNumber(), end: candles[candles.length - 1].close.toNumber(), rows: out,
  }));
}
main().catch((e) => { console.error(e); process.exit(1); });
