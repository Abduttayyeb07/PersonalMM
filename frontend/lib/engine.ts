import api from './api';

export type EngineMode = 'paper' | 'live' | 'backtest';
export type EngineState = 'RUNNING' | 'PAUSED' | 'KILLED' | 'STOPPED' | 'OFFLINE' | 'NOT_STARTED' | 'BACKTEST';
export type RungState = 'IDLE' | 'SELL_LIVE' | 'BUY_LIVE';

export interface EngineOverview {
  mode: EngineMode;
  pair: { id: string; symbol: string; base: string; quote: string; venue: string };
  status: {
    state: EngineState;
    reason: string | null;
    heartbeatAt: string | null;
    leaseHolder: string | null;
    lastInvariantCheck: number | null;
    breaches: Array<{ id: string; message: string; left: string; right: string }>;
  };
  market: { bestBid: string; bestAsk: string } | null;
  config: {
    basePrice: string; floorPrice: string; topPrice: string; stepPct: string;
    ladders: string[]; rungSize: string; maxBaseOwed: string;
  };
  kpis: {
    realisedProfit: string; profitToday: string; profit7d: string;
    cyclesTotal: number; cyclesToday: number; cycles7d: number; refills: number; openCycles: number;
    baseOwed: string; reserve: string; unsweptProfit: string; swept: string;
    avgProfitPerCycle: string | null; avgCycleMinutes: number | null; feesPaid: string;
    baseAtStart: string | null; quoteAtStart: string | null; baseHeld: string | null; liveOrders: number;
  };
  series: Array<{ day: string; profit: string; cycles: number; cumulative: string }>;
  rungs: Array<{
    key: string; ladder: string; n: number; state: RungState; cycle: number;
    sellPrice: string; buyPrice: string; owed: string; refills: number; profit: string;
    order: { side: 'BUY' | 'SELL'; price: string; status: string } | null;
    waiting: string | null;
  }>;
  recentCycles: Array<{
    rung: string; cycle: number; qty: string; sellPrice: string; buyPrice: string; profit: string;
    openedAt: string | null; closedAt: string; netted: boolean;
  }>;
  events: Array<{ ts: string; kind: string; actor: string | null; detail: Record<string, unknown> }>;
}

export const getEngineOverview = (mode: EngineMode) => api.get<EngineOverview>('/engine/overview', { params: { mode } });
export const killEngine = (mode: 'paper' | 'live') => api.post('/engine/kill', { mode });
export const resumeEngine = (mode: 'paper' | 'live', accountPassword: string) => api.post('/engine/resume', { mode, accountPassword });

/** The server's error message from an axios error, or a fallback. */
export function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { status?: number; data?: { message?: unknown } } };
  const m = e?.response?.data?.message;
  return Array.isArray(m) ? m.join(', ') : typeof m === 'string' ? m : fallback;
}

export function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

// ── Formatting ────────────────────────────────────────────────────────────────

const num = (v: string | number) => (typeof v === 'number' ? v : Number(v));

export function usd(v: string | number, opts: { sign?: boolean } = {}): string {
  const n = num(v);
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${sign}$${s}`;
}

export function qty(v: string | number): string {
  const n = num(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 });
}

export function compact(v: string | number): string {
  const n = num(v);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(0)}K`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return qty(n);
}

export function price(v: string | number): string {
  return num(v).toFixed(5);
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} days`;
}

export function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Plain-language activity lines for the audit log. */
export function describeEvent(e: EngineOverview['events'][number]): { text: string; tone: 'neutral' | 'good' | 'bad' } {
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'GENESIS': return { text: `Starting balances recorded: ${qty(String(d.base ?? 0))} base, ${qty(String(d.quote ?? 0))} quote`, tone: 'neutral' };
    case 'LEASE_ACQUIRED': return { text: 'Engine took control of this pair', tone: 'neutral' };
    case 'RUNNING': return { text: 'Engine is trading', tone: 'good' };
    case 'KILL': return { text: `Stopped by kill switch: ${String(d.reason ?? 'no reason given')}`, tone: 'bad' };
    case 'KILL_REQUESTED': return { text: `Stop requested by ${String(d.by ?? e.actor ?? 'someone')}`, tone: 'bad' };
    case 'RESUME':
    case 'RESUME_REQUESTED': return { text: `Restart requested by ${String(d.by ?? e.actor ?? 'someone')}`, tone: 'good' };
    case 'PAUSED': return { text: `Paused: ${String(d.reason ?? '')}`, tone: 'bad' };
    case 'RESTART_BLOCKED': return { text: 'Restart blocked: balances did not reconcile', tone: 'bad' };
    case 'LEASE_LOST': return { text: 'Lost control of the pair to another instance', tone: 'bad' };
    case 'NETTED': return { text: `Netted ${String(d.buy)} against ${String(d.sell)} internally (no trade sent)`, tone: 'neutral' };
    case 'PARTIAL_SELL_EXCEPTION': return { text: `${String(d.rung)}: partial sell, buying back only what sold`, tone: 'neutral' };
    case 'SIMULATION_STARTED': return { text: `Simulation started by ${String(d.by ?? e.actor ?? 'you')}`, tone: 'good' };
    case 'SIMULATION_STOPPED': return { text: `Simulation stopped: ${String(d.reason ?? 'by user')}`, tone: 'neutral' };
    case 'SWEEP': return { text: `Profit sweep of ${usd(String(d.amount ?? 0))} recorded`, tone: 'good' };
    default: return { text: e.kind.toLowerCase().replace(/_/g, ' '), tone: 'neutral' };
  }
}

// ── Paper simulation ──────────────────────────────────────────────────────────

export interface SimSettings {
  startZig: string;
  startUsdt: string;
  rungSize: string;
  stepPct: string;
  ladders: 1 | 2;
  basePrice: string | null;
  floorPrice: string;
  topPrice: string;
  maxCycles: number | null;
  maxHours: number | null;
}

export interface SimStatus {
  running: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  settings: SimSettings;
  defaults: SimSettings;
  marketPrice: string | null;
}

export interface SimPreview {
  rungs: number;
  rungsAboveMarket: number;
  zigNeededForAllSells: string;
  zigArmedAtStart: string;
  basePrice: string;
  marketPrice: string;
  profitPerCycle: string;
  lowestRung: string | null;
  highestRung: string | null;
}

export const getSimulation = () => api.get<SimStatus>('/engine/simulation');
export const previewSimulation = (settings: SimSettings) => api.post<SimPreview>('/engine/simulation/preview', { settings });
export const startSimulation = (settings: SimSettings) => api.post<SimStatus>('/engine/simulation/start', { settings });
export const stopSimulation = () => api.post<SimStatus>('/engine/simulation/stop');

export function elapsed(fromIso: string | null, now = Date.now()): string {
  if (!fromIso) return '—';
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export interface SimAudit {
  ranAt: string;
  running: boolean;
  startedAt: string;
  orders: number;
  fills: number;
  cancels: number;
  cycles: number;
  passed: number;
  failed: number;
  checks: Array<{ id: string; rule: string; pass: boolean; detail: string }>;
}

export const auditSimulation = () => api.get<SimAudit>('/engine/simulation/audit');
