'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '../../store/auth';
import { errorMessage, price } from '../../lib/engine';
import { STATUS_INFO, SeriesOverview, getSeries } from '../../lib/series';
import ConnectExchange from '../ConnectExchange';
import { Card, Empty } from '../console/ui';
import { ControlBar, DashboardPage, midOf } from './Dashboard';
import { NewSeriesPage } from './NewSeries';
import { ActivityList, FillsTable, HistoryTable, LoopsTable, OrdersTable } from './Tables';

type Tab = 'dashboard' | 'orders' | 'fills' | 'loops' | 'history' | 'new' | 'keys';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'orders', label: 'Orders' },
  { id: 'fills', label: 'Fills' },
  { id: 'loops', label: 'Loops' },
  { id: 'history', label: 'Series history' },
  { id: 'new', label: 'New series' },
  { id: 'keys', label: 'Exchange keys' },
];

const HEADINGS: Record<Tab, { title: string; lede: string }> = {
  dashboard: { title: 'Series dashboard', lede: 'Sells go up from your base. Every filled sell buys back 3% lower; every filled buyback books its profit and sells again 3% higher.' },
  orders: { title: 'Orders', lede: 'Each order slot: what it is waiting as now, where it sits against the market, and what it has earned.' },
  fills: { title: 'Fills', lede: 'Every first sell, buyback and re-sell that filled, newest first.' },
  loops: { title: 'Loops', lede: 'Each completed sell and buyback, and the profit it booked.' },
  history: { title: 'Series history', lede: 'Every series you have run. A new base starts the next one.' },
  new: { title: 'New series', lede: 'Set the base price and the order ladder. Starting replaces the running series and cancels its orders.' },
  keys: { title: 'Exchange keys', lede: 'Connect a trade-only key. It is encrypted for your account only and can never be read back.' },
};

function readTab(): Tab {
  try {
    const v = localStorage.getItem('zig.series.tab') as Tab | null;
    return v && TABS.some((t) => t.id === v) ? v : 'dashboard';
  } catch { return 'dashboard'; }
}

/** Polls the user's series every 4 s. */
function useSeries() {
  const [data, setData] = useState<SeriesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const { data } = await getSeries();
      setData(data);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Could not reach the backend'));
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  return { data, error, reload: load };
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export default function SeriesConsole() {
  const { email, logout } = useAuthStore();
  const [tab, setTab] = useState<Tab>(readTab);
  const { data: o, error, reload } = useSeries();
  const now = useNow();
  const go = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem('zig.series.tab', t); } catch { /* not remembered */ }
    window.scrollTo({ top: 0 });
  };
  const s = o?.series ?? null;
  const mid = o ? midOf(s, o.marketPrice) : null;
  const heading = HEADINGS[tab];
  const status = o && s ? STATUS_INFO[o.running ? s.status : 'STOPPED'] : null;
  const showControl = tab !== 'keys' && tab !== 'new';

  return (
    <div className="min-h-screen">
      <header className="c-header">
        <div className="c-brand">
          <span className="c-brand-mark" aria-hidden>Z</span>
          <span className="c-brand-name">ZIG Series<span className="c-brand-sub">Sell-first loops</span></span>
        </div>
        <div className="c-header-context">
          {s ? <>Series <b>{s.label}</b> <span style={{ margin: '0 12px', color: 'var(--faint)' }}>/</span> base <b className="num">{price(s.plan.basePrice)}</b></> : 'No series yet'}
        </div>
        <div className="c-header-right">
          {mid !== null && (
            <span className="c-hide-sm" style={{ color: 'var(--muted)' }}>
              ZIG/USDT <span className="num" style={{ color: 'var(--ink)' }}>{price(mid)}</span>
            </span>
          )}
          {status && <span className="c-pill c-hide-sm"><i style={{ background: status.color }} />{status.label}</span>}
          <span className="c-mode-badge">Paper</span>
          <span className="c-avatar" title={email ?? ''}>{(email ?? '?')[0].toUpperCase()}</span>
          <button type="button" className="c-link" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="c-main">
        <div className="c-heading">
          <div>
            <p className="c-kicker">ZIG / USDT · Bybit spot</p>
            <h1 className="c-title">{heading.title}<span>.</span></h1>
            <p className="c-lede">{heading.lede}</p>
          </div>
        </div>

        <nav className="c-tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              {t.label}
              {t.id === 'orders' && s && o?.running && <span className="c-count num">{s.totals.openSells + s.totals.openBuys}</span>}
              {t.id === 'fills' && s && s.fills.length > 0 && <span className="c-count num">{s.totals.sellFills + s.totals.buyFills}</span>}
              {t.id === 'loops' && s && s.totals.cycles > 0 && <span className="c-count num">{s.totals.cycles}</span>}
            </button>
          ))}
        </nav>

        {error && !o && (
          <div className="c-card c-card-pad"><Empty title="The dashboard could not load">{error}. Check that the backend is running; this page retries every few seconds.</Empty></div>
        )}

        {o && showControl && <ControlBar o={o} now={now} onChanged={reload} onNew={() => go('new')} />}

        {o && tab === 'dashboard' && <DashboardPage o={o} />}
        {o && tab === 'orders' && (s
          ? <Card title={`Series ${s.label} orders`} sub={`${s.totals.openSells} sells and ${s.totals.openBuys} buybacks open.`} pad><OrdersTable orders={s.orders} mid={mid} /></Card>
          : <div className="c-card c-card-pad"><Empty title="No series yet" /></div>)}
        {o && tab === 'fills' && (s
          ? <Card title={`Series ${s.label} fills`} sub={`${s.totals.sellFills} sells and ${s.totals.buyFills} buybacks filled. The latest 300 are listed.`}><FillsTable fills={s.fills} /></Card>
          : <div className="c-card c-card-pad"><Empty title="No series yet" /></div>)}
        {o && tab === 'loops' && (s
          ? (
            <div className="c-grid-main">
              <Card title={`Series ${s.label} loops`} sub={`${s.totals.cycles} loops completed.`}><LoopsTable loops={s.loops} /></Card>
              <Card title="Activity"><ActivityList events={s.events} /></Card>
            </div>
          )
          : <div className="c-card c-card-pad"><Empty title="No series yet" /></div>)}
        {o && tab === 'history' && <Card title="All series" sub="Profit and loops of each series, newest first."><HistoryTable rows={o.history} /></Card>}
        {o && tab === 'new' && <NewSeriesPage o={o} onStarted={() => { void reload(); go('dashboard'); }} />}
        {tab === 'keys' && <ConnectExchange />}

        <p className="c-footer">Paper trading: live Bybit prices, simulated fills and balances. No real orders. Your data is yours alone.</p>
      </main>
    </div>
  );
}
