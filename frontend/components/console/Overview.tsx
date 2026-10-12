'use client';

import { useMemo, useState } from 'react';
import { EngineOverview, ago, compact, dateTime, describeEvent, duration, price, qty, shortDate, usd } from '../../lib/engine';
import { AreaChart, ColumnChart, DataTable, useWidth } from './charts';
import { Card, Empty, KV, Stat } from './ui';

export function PortfolioStrip({ o }: { o: EngineOverview }) {
  const k = o.kpis;
  return (
    <div className="c-strip">
      <Stat label="Realised profit" value={usd(k.realisedProfit)}
            note={<><b style={{ color: 'var(--profit-text)' }}>{usd(k.profitToday, { sign: true })}</b> last 24 h · <b style={{ color: 'var(--profit-text)' }}>{usd(k.profit7d, { sign: true })}</b> last 7 days</>} />
      <Stat label="Cycles completed" value={qty(k.cyclesTotal)}
            note={`${k.refills} refills · ${k.cyclesToday} in the last 24 h`} />
      <Stat label={`${o.pair.base} waiting for buyback`} value={compact(k.baseOwed)}
            note={`${k.openCycles} open ${k.openCycles === 1 ? 'cycle' : 'cycles'} · cap ${compact(o.config.maxBaseOwed)} ${o.pair.base}`} />
      <Stat label={`Reserve (${o.pair.quote})`} value={usd(k.reserve)}
            note="Funds the open buybacks. Never withdrawn." />
    </div>
  );
}

function PerformanceCard({ o }: { o: EngineOverview }) {
  const [view, setView] = useState<'profit' | 'cycles'>('profit');
  const [table, setTable] = useState(false);
  const [ref, width] = useWidth<HTMLDivElement>();
  const profit = useMemo(() => o.series.map((d) => ({ label: shortDate(d.day), value: Number(d.cumulative) })), [o]);
  const cycles = useMemo(() => o.series.map((d) => ({ label: shortDate(d.day), value: d.cycles })), [o]);

  return (
    <Card
      title="Performance"
      sub={view === 'profit' ? `Cumulative realised profit in ${o.pair.quote}, last 30 days` : 'Completed sell-and-buyback cycles per day, last 30 days'}
      action={
        <div className="flex items-center gap-3">
          <div className="c-segment" role="radiogroup" aria-label="Chart">
            <button type="button" role="radio" aria-checked={view === 'profit'} onClick={() => setView('profit')}>Profit</button>
            <button type="button" role="radio" aria-checked={view === 'cycles'} onClick={() => setView('cycles')}>Cycles per day</button>
          </div>
          <button type="button" className="c-btn c-btn-ghost" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>
        </div>
      }
    >
      <div className="mb-2 flex items-baseline gap-3">
        <span className="display text-[34px] font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
          {view === 'profit' ? usd(o.kpis.realisedProfit) : qty(o.kpis.cyclesTotal)}
        </span>
        <span className="text-[14px]" style={{ color: 'var(--muted)' }}>{view === 'profit' ? 'realised to date' : 'cycles to date'}</span>
      </div>
      <div ref={ref} className="min-w-0">
        {table ? (
          <DataTable columns={['Day', 'Cycles', 'Profit that day', 'Cumulative']}
                     rows={o.series.map((d) => [shortDate(d.day), String(d.cycles), usd(d.profit), usd(d.cumulative)])} />
        ) : width > 0 && (view === 'profit'
          ? <AreaChart points={profit} width={width} format={(v) => usd(v)} axisFormat={(v) => `$${compact(v)}`} />
          : <ColumnChart points={cycles} width={width} format={(v) => String(Math.round(v))} />)}
      </div>
    </Card>
  );
}

/** Where the market sits inside the configured range, with the base price marked. */
function RangeBar({ o }: { o: EngineOverview }) {
  const floor = Number(o.config.floorPrice);
  const top = Number(o.config.topPrice);
  const base = Number(o.config.basePrice);
  const mid = o.market ? (Number(o.market.bestBid) + Number(o.market.bestAsk)) / 2 : null;
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - floor) / (top - floor)) * 100))}%`;
  return (
    <div className="mt-2">
      <div className="relative h-2 rounded-full" style={{ background: 'linear-gradient(90deg, rgba(76,141,245,.35), rgba(31,174,122,.35), rgba(207,125,31,.4))' }}>
        <span className="absolute top-[-5px] h-[18px] w-[2px]" style={{ left: pos(base), background: 'var(--muted)' }} title={`Base ${price(base)}`} />
        {mid !== null && (
          <span className="absolute top-[-6px] h-5 w-5 -translate-x-1/2 rounded-full"
                style={{ left: pos(mid), background: 'var(--ink)', border: '4px solid var(--gold)', boxShadow: '0 0 0 4px rgba(244,190,98,.15)' }}
                title={`Market ${price(mid)}`} />
        )}
      </div>
      <div className="mt-3 flex justify-between text-[12px]" style={{ color: 'var(--muted)' }}>
        <span>Floor <span className="num">{price(floor)}</span></span>
        <span>Top <span className="num">{price(top)}</span></span>
      </div>
    </div>
  );
}

function LatticeCard({ o }: { o: EngineOverview }) {
  const selling = o.rungs.filter((r) => r.state === 'SELL_LIVE').length;
  const buying = o.rungs.filter((r) => r.state === 'BUY_LIVE').length;
  const mid = o.market ? (Number(o.market.bestBid) + Number(o.market.bestAsk)) / 2 : null;
  const nextSell = mid === null ? null : o.rungs.filter((r) => r.state === 'SELL_LIVE' && Number(r.sellPrice) > mid).map((r) => Number(r.sellPrice)).sort((a, b) => a - b)[0];
  const nextBuy = o.rungs.filter((r) => r.state === 'BUY_LIVE').map((r) => Number(r.buyPrice)).sort((a, b) => b - a)[0];
  return (
    <Card title="Lattice at a glance" sub={`${o.rungs.length} rungs between ${price(o.config.floorPrice)} and ${price(o.config.topPrice)}`}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px]" style={{ color: 'var(--muted)' }}>Market price</span>
        <span className="display text-[30px] font-semibold" style={{ color: 'var(--ink)' }}>{mid !== null ? price(mid) : '—'}</span>
      </div>
      <RangeBar o={o} />
      <div className="mt-6">
        <KV label="Next sell fills at" value={nextSell !== undefined && nextSell !== null ? price(nextSell) : '—'} tone="var(--sell)" />
        <KV label="Next buyback fills at" value={nextBuy !== undefined ? price(nextBuy) : '—'} tone="var(--buy)" />
        <KV label="Selling / buying back" value={`${selling} / ${buying}`} />
        <KV label="Step between rungs" value={`${o.config.stepPct}%`} />
        <KV label="Rung size" value={`${qty(o.config.rungSize)} ${o.pair.base}`} />
        <KV label="Ladders" value={o.config.ladders.join(' + ')} />
        <KV label="Base price" value={price(o.config.basePrice)} />
      </div>
    </Card>
  );
}

function HealthCard({ o, now }: { o: EngineOverview; now: number }) {
  const k = o.kpis;
  return (
    <Card title="Engine health" sub="Proves itself against the exchange every minute.">
      <KV label="Last heartbeat" value={o.mode === 'backtest' ? 'replay' : ago(o.status.heartbeatAt, now)} />
      <KV label="Last invariant check" value={o.status.lastInvariantCheck ? ago(new Date(o.status.lastInvariantCheck).toISOString(), now) : '—'} />
      <KV label="Invariant breaches" value={o.status.breaches.length ? o.status.breaches.map((b) => b.id).join(', ') : 'none'}
          tone={o.status.breaches.length ? 'var(--bad)' : 'var(--good)'} />
      <KV label="Live orders" value={qty(k.liveOrders)} />
      <KV label="Average profit per cycle" value={k.avgProfitPerCycle ? usd(k.avgProfitPerCycle) : '—'} />
      <KV label="Average cycle time" value={duration(k.avgCycleMinutes)} />
      <KV label="Fees paid" value={usd(k.feesPaid)} />
      <KV label="Profit not yet swept" value={usd(k.unsweptProfit)} />
    </Card>
  );
}

export function RecentCyclesTable({ o, limit }: { o: EngineOverview; limit?: number }) {
  const rows = limit ? o.recentCycles.slice(0, limit) : o.recentCycles;
  if (!rows.length) {
    return <Empty title="No cycle has completed yet">A cycle needs the price to rise through a sell and fall back through its buyback, about a 3% round trip.</Empty>;
  }
  return (
    <div className="c-table-wrap" style={{ maxHeight: limit ? undefined : 640 }}>
      <table className="c-table">
        <thead>
          <tr><th>Closed</th><th>Rung</th><th className="r">Quantity</th><th className="r">Sold at</th><th className="r">Bought back at</th><th className="r">Took</th><th className="r">Profit</th></tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={`${c.rung}-${c.cycle}`}>
              <td>{dateTime(c.closedAt)}</td>
              <td className="num strong">{c.rung} <span style={{ color: 'var(--faint)' }}>#{c.cycle}</span></td>
              <td className="r num">{qty(c.qty)}</td>
              <td className="r num">{price(c.sellPrice)}</td>
              <td className="r num">{price(c.buyPrice)}</td>
              <td className="r">{c.openedAt ? duration(Math.round((new Date(c.closedAt).getTime() - new Date(c.openedAt).getTime()) / 60000)) : '—'}</td>
              <td className="r num" style={{ color: 'var(--profit-text)', fontWeight: 500 }}>{usd(c.profit, { sign: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActivityList({ o, limit }: { o: EngineOverview; limit?: number }) {
  const rows = limit ? o.events.slice(0, limit) : o.events;
  if (!rows.length) return <Empty title="Nothing has happened yet" />;
  return (
    <ol>
      {rows.map((e, i) => {
        const d = describeEvent(e);
        const color = d.tone === 'bad' ? 'var(--bad)' : d.tone === 'good' ? 'var(--good)' : 'var(--faint)';
        return (
          <li key={`${e.ts}-${i}`} className="flex gap-4 py-3.5 text-[14px]" style={{ borderTop: i ? '1px solid var(--line-soft)' : undefined }}>
            <span aria-hidden className="mt-[7px] inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="min-w-0 flex-1" style={{ color: 'var(--ink-2)' }}>{d.text}</span>
            <span className="shrink-0 whitespace-nowrap text-[13px]" style={{ color: 'var(--muted)' }}>{dateTime(e.ts)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function OverviewPage({ o, now, onNavigate }: { o: EngineOverview; now: number; onNavigate: (tab: 'cycles' | 'activity') => void }) {
  return (
    <div className="c-section-gap">
      <PortfolioStrip o={o} />
      <div className="c-grid-main">
        <div className="c-section-gap min-w-0">
          <PerformanceCard o={o} />
          <Card title="Latest cycles" sub="Sold, bought the same quantity back lower, kept the difference."
                action={<button type="button" className="c-btn c-btn-ghost" onClick={() => onNavigate('cycles')}>All cycles</button>}>
            <RecentCyclesTable o={o} limit={6} />
          </Card>
          <Card title="Latest activity" action={<button type="button" className="c-btn c-btn-ghost" onClick={() => onNavigate('activity')}>All activity</button>}>
            <ActivityList o={o} limit={6} />
          </Card>
        </div>
        <div className="c-section-gap min-w-0">
          <LatticeCard o={o} />
          <HealthCard o={o} now={now} />
        </div>
      </div>
    </div>
  );
}
