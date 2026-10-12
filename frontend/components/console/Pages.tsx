'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EngineOverview, RungState, compact, price, qty, shortDate, usd } from '../../lib/engine';
import { ColumnChart, DataTable, useWidth } from './charts';
import { ActivityList, RecentCyclesTable } from './Overview';
import { Card, Legend } from './ui';

const RUNG: Record<RungState, { label: string; color: string }> = {
  SELL_LIVE: { label: 'Selling', color: 'var(--sell)' },
  BUY_LIVE: { label: 'Buying back', color: 'var(--buy)' },
  IDLE: { label: 'Idle', color: 'var(--faint)' },
};

export function LadderPage({ o }: { o: EngineOverview }) {
  const [onlyTraded, setOnlyTraded] = useState(false);
  const mid = o.market ? (Number(o.market.bestBid) + Number(o.market.bestAsk)) / 2 : null;
  const rows = onlyTraded ? o.rungs.filter((r) => r.state === 'BUY_LIVE' || r.refills > 0) : o.rungs;
  const maxRefills = Math.max(1, ...o.rungs.map((r) => r.refills));
  const marketIndex = mid === null ? -1 : rows.findIndex((r) => Number(r.sellPrice) < mid);
  const counts = o.rungs.reduce<Record<string, number>>((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {});
  const scroller = useRef<HTMLDivElement>(null);
  const centred = useRef(false);
  useEffect(() => {
    if (centred.current || !scroller.current) return;
    const marker = scroller.current.querySelector<HTMLElement>('[data-market]');
    if (!marker) return;
    scroller.current.scrollTop = marker.offsetTop - scroller.current.clientHeight / 2;
    centred.current = true;
  });

  const market = mid === null ? null : (
    <tr data-market>
      <td colSpan={7} style={{ padding: '10px 16px', borderBottom: 0 }}>
        <div className="flex items-center gap-3 text-[13px] font-semibold" style={{ color: 'var(--gold)' }}>
          <span className="h-px flex-1" style={{ background: 'var(--gold)' }} />
          <span className="num">Market {price(mid)}</span>
          <span className="h-px flex-1" style={{ background: 'var(--gold)' }} />
        </div>
      </td>
    </tr>
  );

  return (
    <Card
      title="Price ladder"
      sub={`Every rung sells ${qty(o.config.rungSize)} ${o.pair.base} at its price and buys the same amount back one step (${o.config.stepPct}%) lower. Refills count completed cycles.`}
      action={
        <button type="button" className="c-btn c-btn-ghost" onClick={() => setOnlyTraded((v) => !v)}>
          {onlyTraded ? `Show all ${o.rungs.length} rungs` : 'Only rungs that traded'}
        </button>
      }
    >
      <div className="mb-5">
        <Legend items={[
          { label: 'Selling', color: RUNG.SELL_LIVE.color, count: counts.SELL_LIVE ?? 0 },
          { label: 'Buying back', color: RUNG.BUY_LIVE.color, count: counts.BUY_LIVE ?? 0 },
          { label: 'Idle', color: RUNG.IDLE.color, count: counts.IDLE ?? 0 },
          { label: 'Refills', color: 'var(--profit)' },
        ]} />
      </div>
      <div ref={scroller} className="c-table-wrap" style={{ maxHeight: 'calc(100vh - 320px)', minHeight: 420 }}>
        <table className="c-table">
          <thead>
            <tr><th>Rung</th><th className="r">Sells at</th><th className="r">Buys back at</th><th>Now</th><th className="r">{o.pair.base} waiting</th><th>Refills</th><th className="r">Earned</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <FragmentRows key={r.key} before={i === marketIndex ? market : null}>
                <tr>
                  <td className="num strong">{r.key}</td>
                  <td className="r num">{price(r.sellPrice)}</td>
                  <td className="r num">{price(r.buyPrice)}</td>
                  <td>
                    <span className="c-pill"><i style={{ background: RUNG[r.state].color }} />{RUNG[r.state].label}</span>
                  </td>
                  <td className="r num">{Number(r.owed) > 0 ? compact(r.owed) : '—'}</td>
                  <td>
                    <span className="flex items-center gap-3">
                      <span className="inline-block w-24">
                        {r.refills > 0 && <span className="block h-2 rounded-full" style={{ width: `${Math.max(6, (r.refills / maxRefills) * 96)}px`, background: 'var(--profit)' }} />}
                      </span>
                      <span className="num" style={{ color: r.refills ? 'var(--ink)' : 'var(--faint)' }}>{r.refills}</span>
                    </span>
                  </td>
                  <td className="r num" style={{ color: Number(r.profit) > 0 ? 'var(--profit-text)' : 'var(--faint)' }}>{Number(r.profit) > 0 ? usd(r.profit) : '—'}</td>
                </tr>
              </FragmentRows>
            ))}
            {marketIndex === -1 && market}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function FragmentRows({ before, children }: { before: React.ReactNode; children: React.ReactNode }) {
  return <>{before}{children}</>;
}

export function CyclesPage({ o }: { o: EngineOverview }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [table, setTable] = useState(false);
  const points = useMemo(() => o.series.map((d) => ({ label: shortDate(d.day), value: d.cycles })), [o]);
  const k = o.kpis;
  return (
    <div className="c-section-gap">
      <div className="c-strip" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <div className="c-stat"><p className="c-stat-label">Cycles completed</p><p className="c-stat-value">{qty(k.cyclesTotal)}</p><p className="c-stat-note">{k.cycles7d} in the last 7 days</p></div>
        <div className="c-stat"><p className="c-stat-label">Average profit per cycle</p><p className="c-stat-value">{k.avgProfitPerCycle ? usd(k.avgProfitPerCycle) : '—'}</p><p className="c-stat-note">After fees on both sides</p></div>
        <div className="c-stat"><p className="c-stat-label">Open cycles</p><p className="c-stat-value">{k.openCycles}</p><p className="c-stat-note">Sold, waiting for the buyback</p></div>
        <div className="c-stat"><p className="c-stat-label">Fees paid</p><p className="c-stat-value">{usd(k.feesPaid)}</p><p className="c-stat-note">All maker; every order is post-only</p></div>
      </div>
      <Card title="Cycles per day" sub="Completed sell-and-buyback cycles, last 30 days"
            action={<button type="button" className="c-btn c-btn-ghost" onClick={() => setTable((t) => !t)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>}>
        <div ref={ref} className="min-w-0">
          {table
            ? <DataTable columns={['Day', 'Cycles', 'Profit']} rows={o.series.map((d) => [shortDate(d.day), String(d.cycles), usd(d.profit)])} />
            : width > 0 && <ColumnChart points={points} width={width} format={(v) => String(Math.round(v))} />}
        </div>
      </Card>
      <Card title="Cycle history" sub="Newest first. Each row sold, bought the same quantity back lower, and kept the difference.">
        <RecentCyclesTable o={o} />
      </Card>
    </div>
  );
}

export function ActivityPage({ o }: { o: EngineOverview }) {
  return (
    <Card title="Activity" sub="Every start, stop, kill switch, netting and sweep, from the append-only audit log.">
      <ActivityList o={o} />
    </Card>
  );
}
