'use client';

import { useState } from 'react';
import { SimAudit, auditSimulation, dateTime, errorMessage } from '../../lib/engine';
import { Card } from './ui';

/**
 * Independent check of the run against the build spec: replays every order, cancel and fill the
 * simulated exchange saw and tests each rule, without trusting the engine's own bookkeeping.
 */
export function AuditCard() {
  const [audit, setAudit] = useState<SimAudit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { data } = await auditSimulation();
      setAudit(data);
    } catch (e) {
      setError(errorMessage(e, 'The audit could not run.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Spec audit"
      sub="Checks this run against the build spec using the exchange's own record of every order and fill."
      action={<button type="button" className="c-btn c-btn-primary" disabled={busy} onClick={run}>{busy ? 'Auditing…' : audit ? 'Run again' : 'Run audit'}</button>}
    >
      {error && <p role="alert" className="c-error">{error}</p>}
      {!audit && !error && <p className="text-[14px] leading-6" style={{ color: 'var(--muted)' }}>Run it any time during or after a simulation.</p>}
      {audit && (
        <>
          <div className="mb-4 flex items-baseline gap-3">
            <span className="display text-[30px] font-semibold" style={{ color: audit.failed ? 'var(--bad)' : 'var(--good)' }}>
              {audit.failed ? `${audit.failed} failing` : 'All checks pass'}
            </span>
            <span className="text-[13px]" style={{ color: 'var(--muted)' }}>{audit.passed}/{audit.passed + audit.failed} rules</span>
          </div>
          <p className="mb-4 text-[13px]" style={{ color: 'var(--muted)' }}>
            {audit.orders} orders, {audit.fills} fills, {audit.cancels} cancels and {audit.cycles} completed cycles since {dateTime(audit.startedAt)}.
          </p>
          <ul>
            {audit.checks.map((c) => (
              <li key={c.id + c.rule} className="flex gap-3 py-3 text-[13px]" style={{ borderTop: '1px solid var(--line-soft)' }}>
                <span aria-hidden className="mt-[1px] w-4 shrink-0 font-bold" style={{ color: c.pass ? 'var(--good)' : 'var(--bad)' }}>{c.pass ? '✓' : '✗'}</span>
                <span className="min-w-0">
                  <span style={{ color: 'var(--ink)' }}>{c.rule}</span>
                  <span className="sr-only">{c.pass ? ' passed' : ' failed'}</span>
                  <span className="mt-0.5 block leading-5" style={{ color: 'var(--muted)' }}>{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
