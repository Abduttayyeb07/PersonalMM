'use client';

import { FormEvent, ReactNode, useState } from 'react';
import { EngineState, errorMessage } from '../../lib/engine';

export function Card({ title, sub, action, children, pad = true, className = '' }: {
  title?: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; pad?: boolean; className?: string;
}) {
  return (
    <section className={`c-card ${pad ? 'c-card-pad' : ''} ${className}`}>
      {(title || action) && (
        <header className="c-card-head">
          <div>
            {title && <h2 className="c-card-title">{title}</h2>}
            {sub && <p className="c-card-sub">{sub}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="c-stat">
      <p className="c-stat-label">{label}</p>
      <p className="c-stat-value">{value}</p>
      {note && <p className="c-stat-note">{note}</p>}
    </div>
  );
}

export function KV({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="c-kv">
      <span>{label}</span>
      <b className="num" style={tone ? { color: tone } : undefined}>{value}</b>
    </div>
  );
}

export const STATUS: Record<EngineState, { label: string; color: string; help: string }> = {
  RUNNING: { label: 'Running', color: 'var(--good)', help: 'Trading the lattice.' },
  PAUSED: { label: 'Paused', color: 'var(--warn)', help: 'No new orders. It retries the restart procedure on its own.' },
  KILLED: { label: 'Stopped by kill switch', color: 'var(--bad)', help: 'Every order was cancelled. A human must resume.' },
  STOPPED: { label: 'Stopped', color: 'var(--faint)', help: 'Not trading.' },
  OFFLINE: { label: 'Offline', color: 'var(--faint)', help: 'No heartbeat for 30 seconds: the engine is not running.' },
  NOT_STARTED: { label: 'Not started', color: 'var(--faint)', help: 'This engine has never run.' },
  BACKTEST: { label: 'Backtest replay', color: 'var(--buy)', help: 'A replay of real market data. No orders were placed.' },
};

export function StatusDot({ state }: { state: EngineState }) {
  const s = STATUS[state];
  const live = state === 'RUNNING';
  return (
    <span className="c-dot" aria-hidden style={{ background: s.color, boxShadow: live ? `0 0 0 4px rgba(63, 208, 143, 0.15)` : undefined }} />
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string; count?: number }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {items.map((i) => (
        <span key={i.label} className="c-pill">
          <i style={{ background: i.color }} />{i.label}
          {i.count !== undefined && <span className="num" style={{ color: 'var(--muted)' }}>{i.count}</span>}
        </span>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-[16px] font-medium" style={{ color: 'var(--ink-2)' }}>{title}</p>
      {children && <div className="max-w-[460px] text-[14px] leading-6" style={{ color: 'var(--muted)' }}>{children}</div>}
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, danger, needPassword, onConfirm, onClose }: {
  title: string; body: string; confirmLabel: string; danger?: boolean; needPassword?: boolean;
  onConfirm: (password: string) => Promise<void>; onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onConfirm(password);
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'That did not work. Try again.'));
    } finally {
      setPassword('');
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(3, 8, 18, 0.7)' }} role="dialog" aria-modal="true" aria-label={title}>
      <form onSubmit={submit} className="c-card c-card-pad w-full max-w-[480px]">
        <h2 className="c-card-title">{title}</h2>
        <p className="mt-3 text-[15px] leading-7" style={{ color: 'var(--muted)' }}>{body}</p>
        {needPassword && (
          <div className="c-field mt-5">
            <label htmlFor="confirm-password">Account password</label>
            <input id="confirm-password" type="password" required autoComplete="current-password" className="c-input"
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        )}
        {error && <p role="alert" className="c-error mt-4">{error}</p>}
        <div className="mt-7 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="c-btn c-btn-ghost">Cancel</button>
          <button type="submit" disabled={busy} className={`c-btn ${danger ? 'c-btn-danger' : 'c-btn-primary'}`}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
