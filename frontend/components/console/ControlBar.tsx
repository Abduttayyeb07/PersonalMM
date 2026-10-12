'use client';

import { useState } from 'react';
import {
  EngineOverview, SimStatus, ago, elapsed, errorMessage, killEngine, resumeEngine, startSimulation, stopSimulation,
} from '../../lib/engine';
import { ConfirmDialog, STATUS, StatusDot } from './ui';

/**
 * Start and Stop are two separate controls, not one toggle: they are not symmetric actions, and a
 * button that changes meaning is the one you mis-press while watching a number move.
 */
export function ControlBar({ o, sim, now, onChanged, onOpenSettings }: {
  o: EngineOverview | null; sim: SimStatus | null; now: number; onChanged: () => void; onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'kill' | 'resume' | null>(null);
  const mode = o?.mode ?? 'paper';

  async function run(action: 'start' | 'stop') {
    if (!sim) return;
    setBusy(action);
    setError(null);
    try {
      if (action === 'start') await startSimulation(sim.settings);
      else await stopSimulation();
      onChanged();
    } catch (e) {
      setError(errorMessage(e, 'The engine did not respond.'));
    } finally {
      setBusy(null);
    }
  }

  if (mode === 'paper') {
    const running = !!sim?.running;
    return (
      <div className="c-control">
        <div className="c-control-state">
          <span className="c-dot" aria-hidden style={{ background: running ? 'var(--good)' : 'var(--faint)', boxShadow: running ? '0 0 0 4px rgba(63,208,143,.15)' : undefined }} />
          <div>
            <b>{running ? 'Simulation running' : 'Simulation stopped'}</b>
            <small>
              {running
                ? `Running for ${elapsed(sim?.startedAt ?? null, now)} on live Bybit prices · simulated fills, no real orders`
                : sim?.stopReason ? `Last run ${sim.stopReason}` : 'Ready when you are. Uses your simulation settings.'}
            </small>
          </div>
        </div>
        <button type="button" className="c-btn c-btn-primary" disabled={running || busy !== null || !sim} onClick={() => run('start')}>
          {busy === 'start' ? 'Starting…' : 'Start simulation'}
        </button>
        <button type="button" className="c-btn c-btn-danger" disabled={!running || busy !== null} onClick={() => run('stop')}>
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </button>
        <button type="button" className="c-btn c-btn-ghost" onClick={onOpenSettings}>Simulation settings</button>
        {error && <p role="alert" className="c-error basis-full">{error}</p>}
      </div>
    );
  }

  if (!o) return null;
  const s = STATUS[o.status.state];
  return (
    <div className="c-control">
      <div className="c-control-state">
        <StatusDot state={o.status.state} />
        <div>
          <b>{mode === 'live' ? `Live engine · ${s.label}` : s.label}</b>
          <small>
            {o.status.reason ?? s.help}
            {mode === 'live' && o.status.heartbeatAt && ` Last heartbeat ${ago(o.status.heartbeatAt, now)}.`}
          </small>
        </div>
      </div>
      {mode === 'live' && ['RUNNING', 'PAUSED'].includes(o.status.state) && (
        <button type="button" className="c-btn c-btn-danger" onClick={() => setDialog('kill')}>Stop engine</button>
      )}
      {mode === 'live' && o.status.state === 'KILLED' && (
        <button type="button" className="c-btn c-btn-primary" onClick={() => setDialog('resume')}>Resume trading</button>
      )}
      {dialog === 'kill' && (
        <ConfirmDialog title="Stop the live engine?" danger confirmLabel="Stop engine"
          body="The engine cancels every open order within a second and stops trading. Rungs keep their state. Restarting needs your password."
          onConfirm={async () => { await killEngine('live'); onChanged(); }} onClose={() => setDialog(null)} />
      )}
      {dialog === 'resume' && (
        <ConfirmDialog title="Resume live trading?" needPassword confirmLabel="Resume trading"
          body="The engine re-runs its restart procedure: it replays fills, reconciles balances, and only trades again if everything matches."
          onConfirm={async (pw) => { await resumeEngine('live', pw); onChanged(); }} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
