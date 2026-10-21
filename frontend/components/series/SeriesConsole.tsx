'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '../../store/auth';
import { errorMessage, usd } from '../../lib/engine';
import { STATUS_INFO, SeriesDetail, SeriesOverview, getSeries, getSeriesDetail, pairFmt, words, SeriesSymbol } from '../../lib/series';
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
  { id: 'history', label: 'All simulations' },
  { id: 'new', label: 'New simulation' },
  { id: 'keys', label: 'Exchange keys' },
];

const HEADINGS: Record<Tab, { title: string; lede: string }> = {
  dashboard: { title: 'Simulation dashboard', lede: '' },
  orders: { title: 'Orders', lede: 'Each order slot of this simulation: what it is waiting as now, where it sits against the market, and what it has earned.' },
  fills: { title: 'Fills', lede: 'Every order of this simulation that filled, newest first.' },
  loops: { title: 'Loops', lede: 'Each completed loop (a sell and a buy) of this simulation and the profit it booked.' },
  history: { title: 'All simulations', lede: 'Every simulation you have run, on any pair. Open one to see its dashboard.' },
  new: { title: 'New simulation', lede: 'Pick a pair, sell first or buy first, and the ladder. It runs next to your other simulations with its own paper wallet.' },
  keys: { title: 'Exchange keys', lede: 'Connect a trade-only key. It is encrypted for your account only and can never be read back.' },
};

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* not remembered */ }
}

/** Polls something every few seconds; `key` changing restarts it. */
function usePoll<T>(fetcher: (() => Promise<T>) | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!fetcher) return;
    try {
      setData(await fetcher());
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Could not reach the backend'));
    }
  }, [fetcher]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, ms);
    return () => clearInterval(t);
  }, [load, ms]);
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

/** One tab per active simulation, plus the one you opened from history, plus a New tab. */
function RunBar({ o, selectedId, onSelect, onNew }: { o: SeriesOverview; selectedId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const shown = o.runs.filter((r) => r.status !== 'STOPPED' || r.id === selectedId);
  return (
    <div className="s-runs" role="tablist" aria-label="Your simulations">
      {shown.map((r) => {
        const fmt = pairFmt(r.symbol);
        const st = STATUS_INFO[r.status] ?? STATUS_INFO.STOPPED;
        return (
          <button key={r.id} type="button" role="tab" aria-selected={r.id === selectedId} className="s-run" onClick={() => onSelect(r.id)}>
            <span className="s-run-top">
              <i style={{ background: st.color }} aria-hidden />
              <b>{fmt.asset}</b> · Series {r.label}
            </span>
            <span className="s-run-sub">
              <span style={{ color: r.direction === 'BUY_FIRST' ? 'var(--buy)' : 'var(--sell)' }}>{words(r.direction).name}</span>
              <span className="num" style={{ color: Number(r.profit) > 0 ? 'var(--profit-text)' : undefined }}>{usd(r.profit)}</span>
            </span>
          </button>
        );
      })}
      {o.running < o.maxRunning && (
        <button type="button" className="s-run s-run-new" onClick={onNew}>
          <span className="s-run-top"><b>+ New simulation</b></span>
          <span className="s-run-sub">{o.running} of {o.maxRunning} running</span>
        </button>
      )}
      <div className="s-runs-total">
        <span>Running now</span>
        <b className="num">{o.running} · {usd(o.runningProfit)}</b>
        <span>All time {usd(o.totalProfit)}</span>
      </div>
    </div>
  );
}

export default function SeriesConsole() {
  const { email, logout } = useAuthStore();
  const [tab, setTab] = useState<Tab>(() => {
    const v = readPref('zig.series.tab') as Tab | null;
    return v && TABS.some((t) => t.id === v) ? v : 'dashboard';
  });
  const [picked, setPicked] = useState<string | null>(() => readPref('zig.series.run'));
  const overviewFetch = useCallback(async () => (await getSeries()).data, []);
  const { data: o, error, reload } = usePoll<SeriesOverview>(overviewFetch, 4000);
  const now = useNow();

  // The simulation on screen: the one you picked if it still exists, else the first running one, else the newest.
  const selectedId = o
    ? (o.runs.some((r) => r.id === picked) ? picked : (o.runs.find((r) => r.status !== 'STOPPED') ?? o.runs[0])?.id ?? null)
    : picked;
  const detailFetch = useCallback(async () => (selectedId ? (await getSeriesDetail(selectedId)).data : null), [selectedId]);
  const { data: rawDetail, reload: reloadDetail } = usePoll<SeriesDetail | null>(selectedId ? detailFetch : null, 4000);
  const s = rawDetail && rawDetail.id === selectedId ? rawDetail : null;

  const go = (t: Tab) => { setTab(t); writePref('zig.series.tab', t); window.scrollTo({ top: 0 }); };
  const select = (id: string) => { setPicked(id); writePref('zig.series.run', id); if (tab === 'history' || tab === 'new' || tab === 'keys') go('dashboard'); };
  const refresh = () => { void reload(); void reloadDetail(); };

  const fmt = pairFmt(s?.symbol);
  const market = s ? o?.markets[s.symbol] : null;
  const mid = s ? midOf(s, market) : null;
  const perRun = tab === 'dashboard' || tab === 'orders' || tab === 'fills' || tab === 'loops';
  const heading = tab === 'dashboard' ? { ...HEADINGS.dashboard, lede: words(s?.direction, fmt.asset).loopLine } : HEADINGS[tab];
  const status = s ? STATUS_INFO[s.status] ?? STATUS_INFO.STOPPED : null;

  return (
    <div className="min-h-screen">
      <header className="c-header">
        <div className="c-brand">
          <span className="c-brand-mark" aria-hidden>Z</span>
          <span className="c-brand-name">ZIG Series<span className="c-brand-sub">ZIG and BTC loops, sell first or buy first</span></span>
        </div>
        <div className="c-header-context">
          {s ? <><b>{fmt.label}</b> <span style={{ margin: '0 12px', color: 'var(--faint)' }}>/</span> Series <b>{s.label}</b> <span style={{ margin: '0 12px', color: 'var(--faint)' }}>/</span> <b>{words(s.direction).name}</b></> : 'No simulation selected'}
        </div>
        <div className="c-header-right">
          {o && (Object.entries(o.markets) as Array<[string, string | null]>).map(([sym, p]) => p && (
            <span key={sym} className="c-hide-sm" style={{ color: 'var(--muted)' }}>
              {pairFmt(sym as SeriesSymbol).label} <span className="num" style={{ color: 'var(--ink)' }}>{pairFmt(sym as SeriesSymbol).price(p)}</span>
            </span>
          ))}
          <span className="c-mode-badge">Paper</span>
          <span className="c-avatar" title={email ?? ''}>{(email ?? '?')[0].toUpperCase()}</span>
          <button type="button" className="c-link" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="c-main">
        <div className="c-heading">
          <div>
            <p className="c-kicker">{s && perRun ? `${fmt.label} · Bybit spot · Series ${s.label}` : 'Bybit spot · paper trading'}</p>
            <h1 className="c-title">{heading.title}<span>.</span></h1>
            <p className="c-lede">{heading.lede}</p>
          </div>
          {status && perRun && <span className="c-pill"><i style={{ background: status.color }} />{status.label}</span>}
        </div>

        {o && <RunBar o={o} selectedId={selectedId} onSelect={select} onNew={() => go('new')} />}

        <nav className="c-tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              {t.label}
              {t.id === 'orders' && s?.running && <span className="c-count num">{s.totals.openSells + s.totals.openBuys}</span>}
              {t.id === 'fills' && s && s.fills.length > 0 && <span className="c-count num">{s.totals.sellFills + s.totals.buyFills}</span>}
              {t.id === 'loops' && s && s.totals.cycles > 0 && <span className="c-count num">{s.totals.cycles}</span>}
              {t.id === 'history' && o && o.runs.length > 0 && <span className="c-count num">{o.runs.length}</span>}
            </button>
          ))}
        </nav>

        {error && !o && (
          <div className="c-card c-card-pad"><Empty title="The dashboard could not load">{error}. Check that the backend is running; this page retries every few seconds.</Empty></div>
        )}

        {o && perRun && !selectedId && (
          <div className="c-card c-card-pad">
            <Empty title="No simulation yet">Open <b>New simulation</b>, pick a pair, sell first or buy first, and start. You can run up to {o.maxRunning} at once.</Empty>
          </div>
        )}
        {o && perRun && selectedId && !s && <div className="c-card c-card-pad"><Empty title="Loading this simulation…" /></div>}
        {o && perRun && s && <ControlBar s={s} now={now} onChanged={refresh} onNew={() => go('new')} />}

        {perRun && s && tab === 'dashboard' && <DashboardPage s={s} market={market} />}
        {perRun && s && tab === 'orders' && (
          <Card title={`${fmt.label} · Series ${s.label} orders`} sub={`${s.totals.openSells} sells and ${s.totals.openBuys} buys open.`}>
            <OrdersTable orders={s.orders} mid={mid} direction={s.direction} fmt={fmt} />
          </Card>
        )}
        {perRun && s && tab === 'fills' && (
          <Card title={`${fmt.label} · Series ${s.label} fills`} sub={`${s.totals.sellFills} sells and ${s.totals.buyFills} buys filled. The latest 300 are listed.`}>
            <FillsTable fills={s.fills} fmt={fmt} direction={s.direction} />
          </Card>
        )}
        {perRun && s && tab === 'loops' && (
          <div className="c-grid-main">
            <Card title={`${fmt.label} · Series ${s.label} loops`} sub={`${s.totals.cycles} loops completed.`}><LoopsTable loops={s.loops} fmt={fmt} /></Card>
            <Card title="Activity"><ActivityList events={s.events} asset={fmt.asset} /></Card>
          </div>
        )}
        {o && tab === 'history' && (
          <Card title="All simulations" sub={`${o.running} running now. Profit of everything you have run: ${usd(o.totalProfit)}.`}>
            <HistoryTable rows={o.runs} onOpen={select} selectedId={selectedId} />
          </Card>
        )}
        {o && tab === 'new' && <NewSeriesPage o={o} onStarted={(id) => { setPicked(id); writePref('zig.series.run', id); void reload(); go('dashboard'); }} />}
        {tab === 'keys' && <ConnectExchange />}

        <p className="c-footer">Paper trading: live Bybit prices, simulated fills and a separate paper wallet per simulation. No real orders. Your data is yours alone.</p>
      </main>
    </div>
  );
}
