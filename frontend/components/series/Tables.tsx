'use client';

import { useState } from 'react';
import { dateTime, price, qty, usd } from '../../lib/engine';
import { KIND_LABEL, OrderKind, SeriesDetail, SeriesFill, SeriesHistoryRow, SeriesOrder, describeSeriesEvent, kindSide, words } from '../../lib/series';
import { Empty } from '../console/ui';

const SIDE_COLOR = { SELL: 'var(--sell)', BUY: 'var(--buy)' } as const;

export function KindPill({ kind }: { kind: OrderKind }) {
  const sell = kindSide(kind) === 'SELL';
  return (
    <span className="s-pill" style={{ color: sell ? 'var(--sell)' : 'var(--buy)', background: sell ? 'rgba(207,125,31,.14)' : 'rgba(76,141,245,.14)' }}>
      {KIND_LABEL[kind]}
    </span>
  );
}

const ORDER_STATUS: Record<SeriesOrder['status'], string> = {
  OPEN: 'Open on the book', SENDING: 'Sending', WAITING: 'Waiting', QUEUED: 'Being placed', CANCELLED: 'Cancelled',
};

/** All order slots: what each is doing now, and what it has earned. */
export function OrdersTable({ orders, mid, direction }: { orders: SeriesOrder[]; mid: number | null; direction: 'SELL_FIRST' | 'BUY_FIRST' }) {
  if (!orders.length) return <Empty title="No orders yet" />;
  const buy = words(direction).buy;
  return (
    <div className="c-table-wrap" style={{ maxHeight: 640 }}>
      <table className="c-table">
        <thead>
          <tr>
            <th>Order</th><th>Now</th><th>Status</th><th className="r">Price</th><th className="r">From market</th>
            <th className="r">ZIG</th><th className="r">{buy ? 'Bought at' : 'Sold at'}</th><th className="r">Loops</th><th className="r">Profit</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const p = o.price ?? o.target;
            const dist = p && mid ? ((Number(p) - mid) / mid) * 100 : null;
            return (
              <tr key={o.slot}>
                <td className="num strong">#{o.slot} <span style={{ color: 'var(--faint)' }}>· loop {o.cycle}</span></td>
                <td><KindPill kind={o.kind} /></td>
                <td title={o.waiting ?? undefined}>
                  <span className="c-pill"><i style={{ background: o.status === 'OPEN' ? SIDE_COLOR[o.side] : 'var(--faint)' }} />{o.waiting ? `Waiting: ${o.waiting}` : ORDER_STATUS[o.status]}</span>
                </td>
                <td className="r num strong">{p ? price(p) : '—'}</td>
                <td className="r num">{dist === null ? '—' : `${dist > 0 ? '+' : ''}${dist.toFixed(2)}%`}</td>
                <td className="r num">{qty(o.qty)}{Number(o.filled) > 0 && <span style={{ color: 'var(--muted)' }}> ({qty(o.filled)} done)</span>}</td>
                <td className="r num">{(buy ? o.boughtAt : o.soldAt) ? price((buy ? o.boughtAt : o.soldAt)!) : '—'}</td>
                <td className="r num">{o.loops}</td>
                <td className="r num" style={{ color: Number(o.loopProfit) > 0 ? 'var(--profit-text)' : undefined }}>{usd(o.loopProfit)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const FILTERS: Record<'SELL_FIRST' | 'BUY_FIRST', Array<{ id: 'ALL' | OrderKind; label: string }>> = {
  SELL_FIRST: [{ id: 'ALL', label: 'All' }, { id: 'FIRST_SELL', label: 'First sells' }, { id: 'BUYBACK', label: 'Buybacks' }, { id: 'RESELL', label: 'Re-sells' }],
  BUY_FIRST: [{ id: 'ALL', label: 'All' }, { id: 'FIRST_BUY', label: 'First buys' }, { id: 'SELLBACK', label: 'Sell-backs' }, { id: 'REBUY', label: 'Re-buys' }],
};

/** Every fill, newest first, filterable by what the order was for. */
export function FillsTable({ fills, maxHeight = 640, filterable = true, direction = 'SELL_FIRST' }: {
  fills: SeriesFill[]; maxHeight?: number; filterable?: boolean; direction?: 'SELL_FIRST' | 'BUY_FIRST';
}) {
  const [filter, setFilter] = useState<'ALL' | OrderKind>('ALL');
  const rows = filter === 'ALL' ? fills : fills.filter((f) => f.kind === filter);
  return (
    <div>
      {filterable && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Show fills of type">
          {FILTERS[direction].map((f) => (
            <button key={f.id} type="button" className="s-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span className="num">{f.id === 'ALL' ? fills.length : fills.filter((x) => x.kind === f.id).length}</span>
            </button>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <Empty title="No fills yet">Orders fill when the Bybit price trades through them. The first sell has to be reached first.</Empty>
      ) : (
        <div className="c-table-wrap" style={{ maxHeight }}>
          <table className="c-table">
            <thead>
              <tr><th>Time</th><th>Order</th><th>Type</th><th className="r">Price</th><th className="r">ZIG</th><th className="r">USDT</th><th className="r">Loop profit</th></tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>{dateTime(f.ts)}</td>
                  <td className="num strong">#{f.slot} <span style={{ color: 'var(--faint)' }}>· loop {f.cycle}</span></td>
                  <td><KindPill kind={f.kind} /></td>
                  <td className="r num strong">{price(f.price)}</td>
                  <td className="r num">{qty(f.qty)}</td>
                  <td className="r num">{Number(f.value).toFixed(2)}</td>
                  <td className="r num" style={{ color: 'var(--profit-text)' }}>{f.loopProfit ? `+${usd(f.loopProfit)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function LoopsTable({ loops }: { loops: SeriesDetail['loops'] }) {
  if (!loops.length) return <Empty title="No loop completed yet">A loop completes when both of its orders fill: a sell and its buyback, or a buy and its sell-back.</Empty>;
  return (
    <div className="c-table-wrap" style={{ maxHeight: 640 }}>
      <table className="c-table">
        <thead>
          <tr><th>Closed</th><th>Order</th><th className="r">ZIG</th><th className="r">Sold at</th><th className="r">Bought at</th><th className="r">Gap</th><th className="r">Profit</th></tr>
        </thead>
        <tbody>
          {loops.map((l) => (
            <tr key={`${l.slot}-${l.cycle}`}>
              <td>{dateTime(l.closedAt)}</td>
              <td className="num strong">#{l.slot} <span style={{ color: 'var(--faint)' }}>· loop {l.cycle}</span></td>
              <td className="r num">{qty(l.qty)}</td>
              <td className="r num" style={{ color: 'var(--sell)' }}>{price(l.sold)}</td>
              <td className="r num" style={{ color: 'var(--buy)' }}>{price(l.bought)}</td>
              <td className="r num">{(((Number(l.sold) - Number(l.bought)) / Number(l.sold)) * 100).toFixed(2)}%</td>
              <td className="r num" style={{ color: 'var(--profit-text)' }}>+{usd(l.profit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryTable({ rows }: { rows: SeriesHistoryRow[] }) {
  if (!rows.length) return <Empty title="No series yet">Start Series A from the New series tab.</Empty>;
  return (
    <div className="c-table-wrap">
      <table className="c-table">
        <thead>
          <tr><th>Series</th><th>Direction</th><th>Status</th><th className="r">Base</th><th className="r">Orders</th><th>Started</th><th>Ended</th><th className="r">Loops</th><th className="r">Profit</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="strong" style={{ fontWeight: 600 }}>Series {r.label}</td>
              <td style={{ color: r.direction === 'BUY_FIRST' ? 'var(--buy)' : 'var(--sell)' }}>{words(r.direction).name}</td>
              <td>
                <span className="c-pill"><i style={{ background: r.status === 'RUNNING' ? 'var(--good)' : 'var(--faint)' }} />{r.status === 'RUNNING' ? 'Running' : 'Stopped'}</span>
                {r.statusReason && r.status !== 'RUNNING' && <div className="mt-1 text-[12px]" style={{ color: 'var(--muted)', whiteSpace: 'normal', maxWidth: 280 }}>{r.statusReason}</div>}
              </td>
              <td className="r num strong">{price(r.basePrice)}</td>
              <td className="r num">{r.orders} × {qty(r.qty)}</td>
              <td>{dateTime(r.startedAt)}</td>
              <td>{r.stoppedAt ? dateTime(r.stoppedAt) : '—'}</td>
              <td className="r num">{r.cycles}</td>
              <td className="r num" style={{ color: Number(r.profit) > 0 ? 'var(--profit-text)' : undefined }}>{usd(r.profit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ActivityList({ events, limit }: { events: SeriesDetail['events']; limit?: number }) {
  const rows = limit ? events.slice(0, limit) : events;
  if (!rows.length) return <Empty title="Nothing has happened yet" />;
  const tone = { good: 'var(--good)', bad: 'var(--bad)', neutral: 'var(--faint)' } as const;
  return (
    <ol className="grid">
      {rows.map((e, i) => {
        const d = describeSeriesEvent(e);
        return (
          <li key={`${e.ts}-${i}`} className="flex gap-3 py-3" style={{ borderTop: i ? '1px solid var(--line-soft)' : undefined }}>
            <span className="c-dot mt-[6px]" style={{ background: tone[d.tone], width: 8, height: 8, flexBasis: 8 }} aria-hidden />
            <div className="min-w-0">
              <p className="text-[14px] leading-6" style={{ color: 'var(--ink-2)' }}>{d.text}</p>
              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>{dateTime(e.ts)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
