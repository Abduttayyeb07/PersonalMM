'use client';

import { useMemo, useState } from 'react';
import { ago, usd } from '../../lib/engine';
import { errorMessage } from '../../lib/engine';
import { PairFmt, STATUS_INFO, SeriesDetail, SeriesVenue, copySeries, otherVenue, pairFmt, stopSeries, venueName, words } from '../../lib/series';
import { AreaChart, useWidth } from '../console/charts';
import { Card, ConfirmDialog, Empty, KV } from '../console/ui';
import { ActivityList, FillsTable, KindPill } from './Tables';

export function midOf(s: SeriesDetail | null, market: string | null | undefined): number | null {
  if (s?.book) return (Number(s.book.bestBid) + Number(s.book.bestAsk)) / 2;
  return market ? Number(market) : null;
}

/** Status of the selected simulation and its own stop button. Other simulations are not touched. */
export function ControlBar({ s, now, onChanged, onNew, onCopied }: {
  s: SeriesDetail; now: number; onChanged: () => void; onNew: () => void; onCopied: (id: string, venue: SeriesVenue) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const target = otherVenue(s.venue);
  // TAO is MEXC-only: there is nothing to copy it to on Bybit.
  const canCopy = !(target === 'BYBIT' && s.symbol === 'TAOUSDT');
  async function copy() {
    setCopying(true);
    setCopyError(null);
    try {
      const { data } = await copySeries(s.id, target);
      onCopied(data.id, target);
    } catch (e) {
      setCopyError(errorMessage(e, `Could not start the copy on ${venueName(target)}.`));
    } finally {
      setCopying(false);
    }
  }
  const fmt = pairFmt(s.symbol);
  const status = STATUS_INFO[s.running ? s.status : s.status === 'STARTING' ? 'STARTING' : 'STOPPED'];
  const out = Number(s.totals.zigOut);
  const active = s.running || s.status === 'STARTING';
  return (
    <div className="c-control">
      <div className="c-control-state">
        <span className="c-dot" aria-hidden style={{ background: status.color, boxShadow: s.running ? '0 0 0 4px rgba(63,208,143,.15)' : undefined }} />
        <div>
          <b>{s.mode === 'live' && <span className="s-live-tag" style={{ marginLeft: 0, marginRight: 8 }}>LIVE</span>}{`${venueName(s.venue)} · ${fmt.label} · Series ${s.label} · ${status.label}`}</b>
          <small>
            {active && `${words(s.direction).name} · base ${fmt.price(s.plan.basePrice)} · started ${ago(s.startedAt, now)} · ${s.statusReason ?? status.help}`}
            {!active && `Ended ${s.stoppedAt ? ago(s.stoppedAt, now) : ''}${s.statusReason ? `: ${s.statusReason}` : ''}`}
          </small>
        </div>
      </div>
      {canCopy && (
        <button type="button" className="c-btn c-btn-ghost" disabled={copying} onClick={() => void copy()}
                title={`Start the same simulation on ${venueName(target)}: same pair, direction, wallet, percentages and base price ${fmt.price(s.plan.basePrice)}`}>
          {copying ? 'Copying…' : `Copy to ${venueName(target)}`}
        </button>
      )}
      {active ? (
        <button type="button" className="c-btn c-btn-danger" onClick={() => setConfirm(true)}>Stop this simulation</button>
      ) : (
        <button type="button" className="c-btn c-btn-primary" onClick={onNew}>Start a new simulation</button>
      )}
      {copyError && <p className="c-error w-full" role="alert">{copyError}</p>}
      {confirm && (
        <ConfirmDialog
          title={`Stop ${fmt.label} Series ${s.label}?`}
          body={`All ${s.totals.openSells + s.totals.openBuys} open orders of this simulation are cancelled and it ends. Profit stays recorded. Your other simulations keep running.${out > 0 ? ` ${fmt.amount(out)} ${fmt.asset} is sold and waiting for buybacks; it stays as USDT.` : out < 0 ? ` ${fmt.amount(-out)} ${fmt.asset} is bought and waiting for sell-backs; it stays as ${fmt.asset}.` : ''}`}
          confirmLabel="Stop and cancel its orders"
          danger
          onConfirm={async () => { await stopSeries(s.id); onChanged(); }}
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
function Ladder({ s, mid, fmt }: { s: SeriesDetail; mid: number | null; fmt: PairFmt }) {
  const rows = s.orders.filter((o) => o.price || o.target).map((o) => ({ ...o, at: Number(o.price ?? o.target) }));
  rows.sort((a, b) => b.at - a.at);
  const marketIndex = mid === null ? -1 : rows.findIndex((r) => r.at < mid);
  const lines: Array<{ type: 'order'; r: (typeof rows)[number] } | { type: 'market' }> = [];
  rows.forEach((r, i) => {
    if (i === marketIndex) lines.push({ type: 'market' });
    lines.push({ type: 'order', r });
  });
  if (mid !== null && marketIndex === -1) lines.push({ type: 'market' });
  if (!rows.length) return <Empty title="No orders resting">This simulation has no open orders.</Empty>;
  return (
    <div className="s-ladder" role="list">
      {lines.map((l, i) => l.type === 'market' ? (
        <div key={`m${i}`} className="s-ladder-market" role="listitem">
          <span>Market</span><b className="num">{mid !== null ? fmt.price(mid) : '—'}</b>
        </div>
      ) : (
        <div key={l.r.slot} className="s-ladder-row" role="listitem" data-side={l.r.side}>
          <span className="num s-ladder-price">{fmt.price(l.r.at)}</span>
          <KindPill kind={l.r.kind} />
          <span className="s-ladder-who">#{l.r.slot} · loop {l.r.cycle}</span>
          <span className="num s-ladder-qty">{fmt.amount(l.r.qty)} {fmt.asset}</span>
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
        ? <Empty title="No profit booked yet">Profit is booked each time a loop closes: {words(s.direction).buy ? 'a sell-back fills above its buy' : 'a buyback fills below its sell'}.</Empty>
        : width > 0 && <AreaChart points={points} width={width} format={(v) => usd(v)} axisFormat={(v) => `$${v.toFixed(v < 10 ? 2 : 0)}`} />}
    </div>
  );
}

export function DashboardPage({ s, market }: { s: SeriesDetail; market: string | null | undefined }) {
  const fmt = pairFmt(s.symbol);
  const mid = midOf(s, market);
  const t = s.totals;
  const st = s.settings;
  const w = words(s.direction, fmt.asset);
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
          ? <Figure label={`${fmt.asset} bought, not yet sold back`} value={fmt.amount(Math.max(-out, 0))} note={out < 0 ? `${usd(-Number(t.usdtHeldForBuybacks))} of USDT is in it` : `Every bought ${fmt.asset} is sold back`} />
          : <Figure label={`${fmt.asset} sold, not yet bought back`} value={fmt.amount(Math.max(out, 0))} note={out > 0 ? `${usd(t.usdtHeldForBuybacks)} waiting in buybacks` : `Every sold ${fmt.asset} is back`} />}
      </section>

      {s.breaches.length > 0 && <p className="c-error" role="alert">Safety check: {s.breaches.join('; ')}</p>}

      <div className="c-grid-main">
        <Card title="Pending orders" sub={`Every order resting now, highest price first. Sells in amber, buys in blue. Market ${mid ? fmt.price(mid) : '—'}.`}>
          <Ladder s={s} mid={mid} fmt={fmt} />
        </Card>
        <div className="c-section-gap">
          <Card title="This simulation">
            <KV label="Pair" value={`${fmt.label} · ${venueName(s.venue)}`} />
            <KV label="Direction" value={w.name} tone={w.buy ? 'var(--buy)' : 'var(--sell)'} />
            <KV label="Base price" value={fmt.price(s.plan.basePrice)} />
            <KV label="Orders" value={`${st.orders} ${w.opening} × ${fmt.amount(s.plan.qty)} ${fmt.asset}`} />
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
                <KV label={`Total ${fmt.asset}`} value={fmt.amount(st.totalZig)} />
              </>
            )}
            {s.balances && <KV label="Wallet now" value={`${fmt.amount(s.balances.zig)} ${fmt.asset} · ${usd(s.balances.usdt)}`} />}
            <KV label="Fees paid" value={usd(t.fees)} />
            <KV label="Daily base reset" value={s.dailyReset?.nextAt ? `Automatic · next ${new Date(s.dailyReset.nextAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Automatic, 12:00 midnight (Pakistan)'} />
            {s.dailyReset && s.dailyReset.resets > 0 && <KV label="Resets done" value={String(s.dailyReset.resets)} />}
            {s.dailyReset && Number(s.dailyReset.zigLeftOpen) !== 0 && (
              <KV label={Number(s.dailyReset.zigLeftOpen) > 0 ? `${fmt.asset} left sold by resets` : `${fmt.asset} left bought by resets`} value={fmt.amount(Math.abs(Number(s.dailyReset.zigLeftOpen)))} />
            )}
          </Card>
          <Card title="Activity">
            <ActivityList events={s.events} limit={6} asset={fmt.asset} />
          </Card>
        </div>
      </div>

      <div className="c-grid-half">
        <Card title="Latest fills" sub={`Newest first. Each ${w.buy ? 'sell-back' : 'buyback'} that fills closes a loop and books its profit.`}>
          <FillsTable fills={s.fills.slice(0, 12)} fmt={fmt} filterable={false} maxHeight={520} direction={s.direction} />
        </Card>
        <Card title="Profit over time" sub="Running total of booked profit, one step per completed loop.">
          <ProfitChart s={s} />
        </Card>
      </div>
    </div>
  );
}
