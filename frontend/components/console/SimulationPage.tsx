'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  SimPreview, SimSettings, SimStatus, elapsed, errorMessage, previewSimulation, price, qty, startSimulation, stopSimulation, usd,
} from '../../lib/engine';
import { Card, KV } from './ui';
import { AuditCard } from './AuditCard';

type Draft = Omit<SimSettings, 'basePrice' | 'maxCycles' | 'maxHours' | 'ladders'> & {
  ladders: '1' | '2'; basePrice: string; maxCycles: string; maxHours: string;
};

const toDraft = (s: SimSettings): Draft => ({
  ...s, ladders: String(s.ladders) as '1' | '2', basePrice: s.basePrice ?? '',
  maxCycles: s.maxCycles === null ? '' : String(s.maxCycles), maxHours: s.maxHours === null ? '' : String(s.maxHours),
});

const fromDraft = (d: Draft): SimSettings => ({
  startZig: d.startZig.trim(), startUsdt: d.startUsdt.trim() || '0', rungSize: d.rungSize.trim(), stepPct: d.stepPct.trim(),
  ladders: d.ladders === '1' ? 1 : 2, basePrice: d.basePrice.trim() || null,
  floorPrice: d.floorPrice.trim(), topPrice: d.topPrice.trim(),
  maxCycles: d.maxCycles.trim() ? Number(d.maxCycles) : null, maxHours: d.maxHours.trim() ? Number(d.maxHours) : null,
});

function Field({ id, label, hint, value, onChange, disabled, placeholder, suffix }: {
  id: keyof Draft; label: string; hint?: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; placeholder?: string; suffix?: string;
}) {
  return (
    <div className="c-field">
      <label htmlFor={id}>{label}</label>
      <div className="relative">
        <input id={id} className="c-input num" inputMode="decimal" value={value} disabled={disabled} placeholder={placeholder}
               onChange={(e) => onChange(e.target.value)} style={suffix ? { paddingRight: 64 } : undefined} />
        {suffix && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px]" style={{ color: 'var(--muted)' }}>{suffix}</span>}
      </div>
      {hint && <p className="c-hint">{hint}</p>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="pt-2">
      <legend className="mb-5 text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</legend>
      <div className="grid gap-x-6 gap-y-6 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

export function SimulationPage({ sim, now, onChanged }: { sim: SimStatus | null; now: number; onChanged: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<SimPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = !!sim?.running;

  // Fill the form once from the user's saved settings.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (sim && !draft) setDraft(toDraft(sim.settings));
  }, [sim, draft]);

  // Live preview of the lattice these settings would build (debounced).
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await previewSimulation(fromDraft(draft));
        setPreview(data);
        setPreviewError(null);
      } catch (e) {
        setPreview(null);
        setPreviewError(errorMessage(e, 'These settings are not valid.'));
      }
    }, 450);
    return () => clearTimeout(t);
  }, [draft]);

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  async function start(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy('start');
    setError(null);
    try {
      await startSimulation(fromDraft(draft));
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'The simulation did not start.'));
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy('stop');
    setError(null);
    try {
      await stopSimulation();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'The simulation did not stop.'));
    } finally {
      setBusy(null);
    }
  }

  if (!draft || !sim) return <Card><p style={{ color: 'var(--muted)' }}>Loading your simulation settings…</p></Card>;

  return (
    <form onSubmit={start} className="c-grid-main">
      <Card title="Simulation settings"
            sub="A paper run trades your lattice on live Bybit prices with simulated fills and balances. Nothing is sent to an exchange.">
        {running && (
          <p className="c-error mb-6" style={{ color: 'var(--gold-soft)', background: 'var(--gold-wash)', borderColor: 'rgba(244,190,98,.3)' }}>
            A simulation is running. Stop it to change these settings.
          </p>
        )}
        <div className="space-y-10">
          <Group title="Capital">
            <Field id="startZig" label="Starting ZIG" suffix="ZIG" value={draft.startZig} onChange={set('startZig')} disabled={running}
                   hint="ZIG the simulated account starts with. It is also the cap on ZIG sold at once." />
            <Field id="startUsdt" label="Starting USDT" suffix="USDT" value={draft.startUsdt} onChange={set('startUsdt')} disabled={running}
                   hint="Optional. Buybacks are funded from sell proceeds, so 0 works." />
          </Group>
          <Group title="Lattice">
            <Field id="rungSize" label="Rung size" suffix="ZIG" value={draft.rungSize} onChange={set('rungSize')} disabled={running}
                   hint="ZIG each rung sells, then buys back." />
            <Field id="stepPct" label="Step between rungs" suffix="%" value={draft.stepPct} onChange={set('stepPct')} disabled={running}
                   hint="How far below its sell price each rung buys back. 0.5% to 20%." />
            <div className="c-field">
              <label htmlFor="ladders">Ladders</label>
              <select id="ladders" className="c-input" value={draft.ladders} disabled={running} onChange={(e) => set('ladders')(e.target.value)}>
                <option value="2">Two ladders (half a step apart)</option>
                <option value="1">One ladder</option>
              </select>
              <p className="c-hint">Two ladders put a rung every half step, so smaller moves complete cycles.</p>
            </div>
            <Field id="basePrice" label="Base price" suffix="USDT" value={draft.basePrice} onChange={set('basePrice')} disabled={running}
                   placeholder={sim.marketPrice ? `${sim.marketPrice} (market)` : 'market price'}
                   hint="Leave empty to anchor the lattice at the current market price." />
            <Field id="floorPrice" label="Floor price" suffix="USDT" value={draft.floorPrice} onChange={set('floorPrice')} disabled={running}
                   hint="No rung sells below this." />
            <Field id="topPrice" label="Top price" suffix="USDT" value={draft.topPrice} onChange={set('topPrice')} disabled={running}
                   hint="No rung sells above this." />
          </Group>
          <Group title="Stop automatically (optional)">
            <Field id="maxCycles" label="After this many cycles" value={draft.maxCycles} onChange={set('maxCycles')} disabled={running}
                   placeholder="No limit" hint="Ends the run once this many sell-and-buyback cycles complete." />
            <Field id="maxHours" label="After this many hours" suffix="hours" value={draft.maxHours} onChange={set('maxHours')} disabled={running}
                   placeholder="No limit" hint="Ends the run after this long. Up to 90 days." />
          </Group>
        </div>
        {error && <p role="alert" className="c-error mt-8">{error}</p>}
        <div className="mt-10 flex flex-wrap gap-3 border-t pt-7" style={{ borderColor: 'var(--line)' }}>
          <button type="submit" className="c-btn c-btn-primary" disabled={running || busy !== null || !!previewError}>
            {busy === 'start' ? 'Starting…' : 'Start simulation'}
          </button>
          <button type="button" className="c-btn c-btn-danger" disabled={!running || busy !== null} onClick={stop}>
            {busy === 'stop' ? 'Stopping…' : 'Stop simulation'}
          </button>
          <button type="button" className="c-btn c-btn-ghost" disabled={running} onClick={() => setDraft(toDraft(sim.defaults))}>
            Reset to defaults
          </button>
        </div>
      </Card>

      <div className="c-section-gap min-w-0">
        <Card title="What these settings build" sub="Recalculated as you type, from live Bybit market data.">
          {previewError ? (
            <p role="alert" className="c-error">{previewError}</p>
          ) : !preview ? (
            <p style={{ color: 'var(--muted)' }}>Calculating…</p>
          ) : (
            <>
              <div className="mb-5">
                <p className="text-[13px]" style={{ color: 'var(--muted)' }}>Estimated profit per completed cycle</p>
                <p className="display mt-2 text-[38px] font-semibold tracking-tight" style={{ color: 'var(--gold)' }}>{usd(preview.profitPerCycle)}</p>
                <p className="c-hint">At the rung just above the market, after the 0.10% maker fee on both sides.</p>
              </div>
              <KV label="Rungs in the lattice" value={qty(preview.rungs)} />
              <KV label="Rungs above the market" value={qty(preview.rungsAboveMarket)} />
              <KV label="ZIG put up for sale at start" value={`${qty(preview.zigArmedAtStart)} ZIG`} />
              <KV label="ZIG to cover every rung" value={`${qty(preview.zigNeededForAllSells)} ZIG`} />
              <KV label="Lowest / highest rung" value={`${preview.lowestRung ? price(preview.lowestRung) : '—'} / ${preview.highestRung ? price(preview.highestRung) : '—'}`} />
              <KV label="Base price used" value={price(preview.basePrice)} />
              <KV label="Market price now" value={price(preview.marketPrice)} />
            </>
          )}
        </Card>
        <Card title="Current run">
          <KV label="Status" value={running ? 'Running' : 'Stopped'} tone={running ? 'var(--good)' : 'var(--muted)'} />
          <KV label="Running for" value={running ? elapsed(sim.startedAt, now) : '—'} />
          <KV label="Last stop" value={sim.stopReason ?? '—'} />
          <p className="c-hint mt-4">Each start is a fresh run: it clears the previous simulation&apos;s rungs and cycles. The activity log is kept.</p>
        </Card>
        <AuditCard />
      </div>
    </form>
  );
}
