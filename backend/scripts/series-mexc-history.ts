import axios from 'axios';
import Decimal from 'decimal.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Candle, loadCandles, saveCandles } from '../src/engine/backtest/candles';
import { mexcPublicSpecs } from '../src/engine/venue/mexc-public';
import { runSeriesBacktest } from '../src/series/backtest';
import { defaultSeriesSettings } from '../src/series/plan';
import { SeriesSettings } from '../src/series/types';

/**
 * "What if I had run it for real": sell-first ZIG/USDT on MEXC's own price history, with the daily
 * reset on, since a start date and over the last 30 days, at MEXC's possible API maker fees.
 *
 *   npx ts-node scripts/series-mexc-history.ts [--zig 5000] [--from 2026-01-01] [--refresh]
 *
 * MEXC keeps 1-minute candles only for recent days, so 5-minute candles are used for both periods.
 */
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

async function fetchMexc5m(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const byStart = new Map<number, Candle>();
  const step = 500 * 5 * 60_000;
  for (let from = fromMs; from < toMs; from += step) {
    const { data } = await axios.get('https://api.mexc.com/api/v3/klines', {
      params: { symbol, interval: '5m', startTime: from, endTime: Math.min(from + step, toMs) - 1, limit: 500 }, timeout: 15_000,
    });
    for (const [t, open, high, low, close, volume] of (Array.isArray(data) ? data : []) as string[][]) {
      byStart.set(Number(t), { start: Number(t), open: new Decimal(open), high: new Decimal(high), low: new Decimal(low), close: new Decimal(close), volume: new Decimal(volume) });
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

async function main() {
  const zig = arg('zig', '5000');
  const fromDate = arg('from', '2026-01-01');
  const cache = join('engine-data', `MEXC-ZIGUSDT-5m-from-${fromDate}.csv`);
  let candles: Candle[];
  if (!process.argv.includes('--refresh') && existsSync(cache)) candles = loadCandles(cache);
  else {
    candles = await fetchMexc5m('ZIGUSDT', Date.parse(`${fromDate}T00:00:00Z`), Date.now());
    saveCandles(cache, candles);
  }
  const live = await mexcPublicSpecs('ZIGUSDT');
  const lastMonth = candles.filter((c) => c.start >= candles[candles.length - 1].start - 30 * 86_400_000);
  console.log(`MEXC ZIGUSDT 5-minute candles: ${candles.length}, ${new Date(candles[0].start).toISOString().slice(0, 10)} -> ${new Date(candles[candles.length - 1].start).toISOString().slice(0, 16)}`);

  const rates = [
    { name: 'recommended 1% / 0.5% / 2%', first: '1', step: '0.5', loop: '2' },
    { name: 'original 3% / 1% / 3%', first: '3', step: '1', loop: '3' },
  ];
  const fees = [{ name: '0%', fee: '0' }, { name: '0.06%', fee: '0.0006' }];
  const periods = [{ name: `since ${fromDate}`, candles }, { name: 'last 30 days', candles: lastMonth }];
  const rows: Array<Record<string, string | number>> = [];
  for (const period of periods) {
    for (const r of rates) {
      for (const f of fees) {
        const settings: SeriesSettings = {
          ...defaultSeriesSettings(), symbol: 'ZIGUSDT', direction: 'SELL_FIRST', totalZig: zig, startUsdt: '0', sellPct: '100',
          basePrice: null, dailyReset: true, firstSellPct: r.first, stepPct: r.step, buybackPct: r.loop, resellPct: r.loop,
        };
        const t0 = Date.now();
        const rep = await runSeriesBacktest({ label: `${period.name} · ${r.name} · fee ${f.name}`, settings, specs: { ...live, makerFee: new Decimal(f.fee) }, candles: period.candles });
        const row = {
          period: period.name, rates: r.name, fee: f.name,
          price: `${rep.startPrice} -> ${rep.endPrice} (low ${rep.lowPrice}, high ${rep.highPrice})`,
          loops: rep.cyclesCompleted, perDay: rep.cyclesPerDay, profit: rep.realisedProfitUsd, fees: rep.feesPaidUsd,
          orders: rep.ordersPlaced, fills: rep.sellFills + rep.buyFills, resets: rep.resets,
          zigStillSoldAtEnd: rep.zigStillSold, accountChange: rep.markToMarketUsd, justHolding: rep.holdUsd, status: rep.status, reason: rep.statusReason ?? '', ended: rep.to,
        };
        rows.push(row);
        console.log(`${row.period} | ${row.rates} | fee ${row.fee} | loops ${row.loops} (${row.perDay}/day) | profit $${row.profit} | fees $${row.fees} | orders ${row.orders} | resets ${row.resets} | account ${row.accountChange} vs hold ${row.justHolding} | ${row.status} ${row.reason} ended ${row.ended} | ${Math.round((Date.now() - t0) / 1000)}s`);
      }
    }
  }
  mkdirSync('engine-data', { recursive: true });
  const out = join('engine-data', `series-mexc-history-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, JSON.stringify({ zig, fromDate, candles: candles.length, rows }, null, 2));
  console.log(`Saved ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
