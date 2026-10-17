'use client';

import { useMemo, useState } from 'react';
import { ago, price, qty, usd } from '../../lib/engine';
import { STATUS_INFO, SeriesDetail, SeriesOverview, stopSeries, words } from '../../lib/series';
import { AreaChart, useWidth } from '../console/charts';
import { Card, ConfirmDialog, Empty, KV } from '../console/ui';
import { ActivityList, FillsTable, KindPill } from './Tables';

export function midOf(s: SeriesDetail | null, market: string | null): number | null {
  if (s?.book) return (Number(s.book.bestBid) + Number(s.book.bestAsk)) / 2;
  return market ? Number(market) : null;
}

/** Status, the one button that matters (stop), and when it started. */
export function ControlBar({ o, now, onChanged, onNew }: { o: SeriesOverview; now: number; onChanged: () => void; onNew: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const s = o.series;
  const status = s ? STATUS_INFO[o.running ? s.status : 'STOPPED'] : null;
  return (
    <div className="c-control">
      <div className="c-control-state">
        <span className="c-dot" aria-hidden style={{ background: status?.color ?? 'var(--faint)', boxShadow: o.running ? '0 0 0 4px rgba(63,208,143,.15)' : undefined }} />
        <div>
          <b>{s ? `Series ${s.label} · ${status!.label}` : 'No series yet'}</b>
          <small>
            {s && o.running && `${words(s.direction).name} · base ${price(s.plan.basePrice)} · started ${ago(s.startedAt, now)} · ${s.statusReason ?? status!.help}`}
            {s && !o.running && `Ended ${s.stoppedAt ? ago(s.stoppedAt, now) : ''}${s.statusReason ? `: ${s.statusReason}` : ''}`}
            {!s && 'Set a base price and start Series A.'}
          </small>
        </div>
      </div>
      {o.running ? (
        <button type="button" className="c-btn c-btn-danger" onClick={() => setConfirm(true)}>Stop series and cancel all orders</button>
      ) : (
        <button type="button" className="c-btn c-btn-primary" onClick={onNew}>{s ? 'Start a new series' : 'Start Series A'}</button>
      )}
      {confirm && s && (
        <ConfirmDialog
          title={`Stop Series ${s.label}?`}
          body={`All ${s.totals.openSells + s.totals.openBuys} open orders are cancelled and the series ends. Profit stays recorded.${Number(s.totals.zigOut) > 0 ? ` ${qty(s.totals.zigOut)} ZIG is sold and waiting for buybacks; it stays as USDT.` : Number(s.totals.zigOut) < 0 ? ` ${qty(-Number(s.totals.zigOut))} ZIG is bought and waiting for sell-backs; it stays as ZIG.` : ''}`}
          confirmLabel="Stop and cancel all orders"
          danger
          onConfirm={async () => { await stopSeries(); onChanged(); }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

function Figure({ label, value, note, hero }: { label: string; value: string; note: string; hero?: boolean }) {
  return (
    <div className="c-stat">
      <p className="c-stat-label">{label}</p>
      <p className="c-stat-value num" style={hero ? undefined : { fontSize: 34 }}>{value}</p>
      <p className="c-stat-note">{note}</p>
    </div>
  );
}

/** Every resting order on one price axis, with the market price where it sits. */
function Ladder({ s, mid }: { s: SeriesDetail; mid: number | null }) {
  const rows = s.orders.filter((o) => o.price || o.target).map((o) => ({ ...o, at: Number(o.price ?? o.target) }));
  rows.sort((a, b) => b.at - a.at);
  const marketIndex = mid === null ? -1 : rows.findIndex((r) => r.at < mid);
  const lines: Array<{ type: 'order'; r: (typeof rows)[number] } | { type: 'market' }> = [];
  rows.forEach((r, i) => {
    if (i === marketIndex) lines.push({ type: 'market' });
    lines.push({ type: 'order', r });
  });
  if (mid !== null && (marketIndex === -1)) lines.push({ type: 'market' });
  return (
    <div className="s-ladder" role="list">
      {lines.map((l, i) => l.type === 'market' ? (
        <div key={`m${i}`} className="s-ladder-market" role="listitem">
          <span>Market</span><b className="num">{mid !== null ? price(mid) : '—'}</b>
        </div>
      ) : (
        <div key={l.r.slot} className="s-ladder-row" role="listitem" data-side={l.r.side}>
          <span className="num s-ladder-price">{price(l.r.at)}</span>
          <KindPill kind={l.r.kind} />
          <span className="s-ladder-who">#{l.r.slot} · loop {l.r.cycle}</span>
          <span className="num s-ladder-qty">{qty(l.r.qty)} ZIG</span>
          <span className="num s-ladder-dist">
            {l.r.status !== 'OPEN' ? (l.r.waiting ?? 'placing') : mid ? `${((l.r.at - mid) / mid * 100) > 0 ? '+' : ''}${((l.r.at - mid) / mid * 100).toFixed(2)}%` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProfitChart({ s }: { s: SeriesDetail }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const points = useMemo(() => {
    const out = [{ label: 'Start', value: 0 }];
    for (const l of [...s.loops].reverse()) {
      out.push({
        label: `#${l.slot} loop ${l.cycle} · ${new Date(l.closedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        value: out[out.length - 1].value + Number(l.profit),
      });
    }
    return out;
  }, [s.loops]);
  return (
    <div ref={ref} className="relative">
      {s.loops.length === 0
        ? <Empty title="No profit booked yet">Profit is booked each time a loop closes: {words(s.direction).buy ? 'a sell-back fills 3% above its buy' : 'a buyback fills 3% below its sell'}.</Empty>
        : width > 0 && <AreaChart points={points} width={width} format={(v) => usd(v)} axisFormat={(v) => `$${v.toFixed(v < 10 ? 2 : 0)}`} />}
    </div>
  );
}

export function DashboardPage({ o }: { o: SeriesOverview }) {
  const s = o.series;
  if (!s) {
    return (
      <div className="c-card c-card-pad">
        <Empty title="No series has run yet">Open <b>New series</b>, choose sell first or buy first, set your base price, and start Series A.</Empty>
      </div>
    );
  }
  const mid = midOf(s, o.marketPrice);
  const t = s.totals;
  const st = s.settings;
  const w = words(s.direction);
  const out = Number(t.zigOut);
  const openOpening = w.buy ? t.openBuys : t.openSells;
  const openClosing = w.buy ? t.openSells : t.openBuys;
  return (
    <div className="c-section-gap">
      <section className="c-strip" aria-label="Totals">
        <Figure hero label="Profit booked" value={usd(t.profit)} note={`${t.cycles} loops · about ${usd(t.profitPerHour)} an hour`} />
        <Figure label="Open orders" value={String(t.openSells + t.openBuys)} note={`${openOpening} ${w.opening} · ${openClosing} ${w.closing}`} />
        <Figure label="Fills" value={String(t.sellFills + t.buyFills)} note={`${t.sellFills} sells · ${t.buyFills} buys`} />
        {w.buy
          ? <Figure label="ZIG bought, not yet sold back" value={qty(Math.max(-out, 0))} note={out < 0 ? `${usd(-Number(t.usdtHeldForBuybacks))} of USDT is in that ZIG` : 'Every bought ZIG is sold back'} />
          : <Figure label="ZIG sold, not yet bought back" value={qty(Math.max(out, 0))} note={out > 0 ? `${usd(t.usdtHeldForBuybacks)} waiting in buybacks` : 'Every sold ZIG is back'} />}
      </section>

      {s.breaches.length > 0 && <p className="c-error" role="alert">Safety check: {s.breaches.join('; ')}</p>}

      <div className="c-grid-main">
        <Card title="Pending orders" sub={`Every order resting now, highest price first. Sells in amber, buys in blue. Market ${mid ? price(mid) : '—'}.`}>
          <Ladder s={s} mid={mid} />
        </Card>
        <div className="c-section-gap">
          <Card title="This series">
            <KV label="Direction" value={w.name} tone={w.buy ? 'var(--buy)' : 'var(--sell)'} />
            <KV label="Base price" value={price(s.plan.basePrice)} />
            <KV label="Orders" value={`${st.orders} ${w.opening} × ${qty(s.plan.qty)} ZIG`} />
            {w.buy ? (
              <>
                <KV label="First buy / step" value={`−${st.firstSellPct}% · −${st.stepPct}% each`} />
                <KV label="Sell-back / re-buy" value={`+${st.resellPct}% · −${st.buybackPct}%`} />
                <KV label="USDT to buy with" value={usd(st.startUsdt)} />
              </>
            ) : (
              <>
                <KV label="First sell / step" value={`+${st.firstSellPct}% · +${st.stepPct}% each`} />
                <KV label="Buyback / re-sell" value={`−${st.buybackPct}% · +${st.resellPct}%`} />
                <KV label="Total ZIG" value={qty(st.totalZig)} />
              </>
            )}
            {s.balances && <KV label="Balance now" value={`${qty(s.balances.zig)} ZIG · ${usd(s.balances.usdt)}`} />}
            <KV label="Fees paid" value={usd(t.fees)} />
            <KV label="Daily reset" value={s.dailyReset ? (s.dailyReset.nextAt ? `On · next ${new Date(s.dailyReset.nextAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'On') : 'Off'} />
            {s.dailyReset && s.dailyReset.resets > 0 && <KV label="Resets done" value={String(s.dailyReset.resets)} />}
            {s.dailyReset && Number(s.dailyReset.zigLeftOpen) !== 0 && (
              <KV label={Number(s.dailyReset.zigLeftOpen) > 0 ? 'ZIG left sold by resets' : 'ZIG left bought by resets'} value={qty(Math.abs(Number(s.dailyReset.zigLeftOpen)))} />
            )}
          </Card>
          <Card title="Activity">
            <ActivityList events={s.events} limit={6} />
          </Card>
        </div>
      </div>

      <div className="c-grid-half">
        <Card title="Latest fills" sub={`Newest first. Each ${w.buy ? 'sell-back' : 'buyback'} that fills closes a loop and books its profit.`}>
          <FillsTable fills={s.fills.slice(0, 12)} filterable={false} maxHeight={520} direction={s.direction} />
        </Card>
        <Card title="Profit over time" sub="Running total of booked profit, one step per completed loop.">
          <ProfitChart s={s} />
        </Card>
      </div>
    </div>
  );
}
