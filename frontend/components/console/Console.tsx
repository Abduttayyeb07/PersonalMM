'use client';

import { useState } from 'react';
import { useAuthStore } from '../../store/auth';
import { EngineMode, price } from '../../lib/engine';
import ConnectExchange from '../ConnectExchange';
import { ControlBar } from './ControlBar';
import { useNow, useOverview, useSimulation } from './data';
import { ActivityPage, CyclesPage, LadderPage } from './Pages';
import { OverviewPage } from './Overview';
import { SimulationPage } from './SimulationPage';
import { Empty, STATUS } from './ui';

type Tab = 'overview' | 'ladder' | 'cycles' | 'activity' | 'simulation' | 'keys';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'ladder', label: 'Price ladder' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'activity', label: 'Activity' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'keys', label: 'Exchange keys' },
];

const HEADINGS: Record<Tab, { title: string; lede: string }> = {
  overview: { title: 'Engine overview', lede: 'Sells ZIG first, buys the same quantity back lower, and keeps the difference in USDT.' },
  ladder: { title: 'Price ladder', lede: 'Every rung, what it is doing right now, and how many times it has refilled.' },
  cycles: { title: 'Cycles', lede: 'Each completed sell and buyback, and the profit it booked.' },
  activity: { title: 'Activity', lede: 'Starts, stops, kill switches and other events, newest first.' },
  simulation: { title: 'Simulation', lede: 'Choose your capital and lattice, then run the engine on live prices with simulated fills.' },
  keys: { title: 'Exchange keys', lede: 'Connect a trade-only key. It is encrypted for your account only and can never be read back.' },
};

const MODES: Array<{ id: EngineMode; label: string }> = [
  { id: 'paper', label: 'Simulation' },
  { id: 'live', label: 'Live' },
  { id: 'backtest', label: 'Backtest' },
];

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
}
function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* not remembered in private mode */ }
}

export default function Console() {
  const { email, logout } = useAuthStore();
  const [tab, setTab] = useState<Tab>(() => readPref<Tab>('zig.tab', 'overview', TABS.map((t) => t.id)));
  const [mode, setMode] = useState<EngineMode>(() => readPref<EngineMode>('zig.mode', 'paper', ['paper', 'live', 'backtest']));
  const { data: o, error, reload } = useOverview(mode);
  const { sim, reload: reloadSim } = useSimulation();
  const now = useNow();

  const go = (t: Tab) => { setTab(t); writePref('zig.tab', t); window.scrollTo({ top: 0 }); };
  const pickMode = (m: EngineMode) => { setMode(m); writePref('zig.mode', m); };
  const refresh = () => { void reload(); void reloadSim(); };
  const usesMode = tab !== 'simulation' && tab !== 'keys';
  const heading = HEADINGS[tab];
  const mid = o?.market ? (Number(o.market.bestBid) + Number(o.market.bestAsk)) / 2 : null;
  const modeLabel = MODES.find((m) => m.id === mode)?.label ?? mode;

  return (
    <div className="min-h-screen">
      <header className="c-header">
        <div className="c-brand">
          <span className="c-brand-mark" aria-hidden>Z</span>
          <span className="c-brand-name">ZIG Grid<span className="c-brand-sub">Sell-first engine</span></span>
        </div>
        <div className="c-header-context">
          Workspace <span style={{ margin: '0 12px', color: 'var(--faint)' }}>/</span> <b>{TABS.find((t) => t.id === tab)?.label}</b>
        </div>
        <div className="c-header-right">
          {mid !== null && (
            <span className="c-hide-sm" style={{ color: 'var(--muted)' }}>
              ZIG/USDT <span className="num" style={{ color: 'var(--ink)' }}>{price(mid)}</span>
            </span>
          )}
          {o && (
            <span className="c-pill c-hide-sm"><i style={{ background: STATUS[o.status.state].color }} />{STATUS[o.status.state].label}</span>
          )}
          <span className="c-mode-badge">{modeLabel}</span>
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
          {usesMode && (
            <div className="c-segment" role="radiogroup" aria-label="Which engine">
              {MODES.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => pickMode(m.id)}>{m.label}</button>
              ))}
            </div>
          )}
        </div>

        <nav className="c-tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              {t.label}
              {t.id === 'cycles' && o && o.kpis.cyclesTotal > 0 && <span className="c-count num">{o.kpis.cyclesTotal}</span>}
              {t.id === 'simulation' && sim?.running && <span className="c-count" style={{ color: 'var(--good)' }}>running</span>}
            </button>
          ))}
        </nav>

        {usesMode && <ControlBar o={o} sim={mode === 'paper' ? sim : null} now={now} onChanged={refresh} onOpenSettings={() => go('simulation')} />}

        {tab === 'simulation' && <SimulationPage sim={sim} now={now} onChanged={refresh} />}
        {tab === 'keys' && <ConnectExchange />}

        {usesMode && error && !o && (
          <div className="c-card c-card-pad"><Empty title="The dashboard could not load">{error}. Check that the backend is running; this page retries every 5 seconds.</Empty></div>
        )}
        {usesMode && o && o.status.state === 'NOT_STARTED' && (
          <div className="c-card c-card-pad mb-7">
            <Empty title={`The ${modeLabel.toLowerCase()} engine has not run yet`}>
              {mode === 'paper' && <>Press <b>Start simulation</b> above, or open <b>Simulation</b> to choose your ZIG, rung size and range first.</>}
              {mode === 'live' && 'Connect a trade-only Bybit key under Exchange keys, record two approvals, then start the live engine from the server.'}
              {mode === 'backtest' && 'Publish a 30-day replay from the server: npm run engine -- backtest --user <your email>.'}
            </Empty>
          </div>
        )}
        {usesMode && o && tab === 'overview' && <OverviewPage o={o} now={now} onNavigate={go} />}
        {usesMode && o && tab === 'ladder' && <LadderPage o={o} />}
        {usesMode && o && tab === 'cycles' && <CyclesPage o={o} />}
        {usesMode && o && tab === 'activity' && <ActivityPage o={o} />}

        <p className="c-footer">
          {mode === 'paper' && usesMode ? 'Simulation: live Bybit prices, simulated fills and balances. No real orders.' : 'Your engine, your keys, your data. Nothing is shared between accounts.'}
        </p>
      </main>
    </div>
  );
}
