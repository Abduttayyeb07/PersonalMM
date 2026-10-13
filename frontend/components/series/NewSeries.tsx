'use client';

import { FormEvent, useEffect, useState } from 'react';
import { errorMessage, price, qty, usd } from '../../lib/engine';
import { SeriesOverview, SeriesPreview, SeriesSettings, previewSeries, seriesLabelFor, startSeries, stopSeries } from '../../lib/series';
import { Card, ConfirmDialog } from '../console/ui';

type Draft = Record<'basePrice' | 'totalZig' | 'sellPct' | 'orders' | 'firstSellPct' | 'stepPct' | 'buybackPct' | 'resellPct' | 'maxHours', string>;

const toDraft = (s: SeriesSettings): Draft => ({
  basePrice: s.basePrice ?? '', totalZig: s.totalZig, sellPct: s.sellPct, orders: String(s.orders),
  firstSellPct: s.firstSellPct, stepPct: s.stepPct, buybackPct: s.buybackPct, resellPct: s.resellPct,
  maxHours: s.maxHours === null ? '' : String(s.maxHours),
});

const fromDraft = (d: Draft): SeriesSettings => ({
  totalZig: d.totalZig.trim(), startUsdt: '0', basePrice: d.basePrice.trim() || null, sellPct: d.sellPct.trim(),
  orders: Number(d.orders), firstSellPct: d.firstSellPct.trim(), stepPct: d.stepPct.trim(),
  buybackPct: d.buybackPct.trim(), resellPct: d.resellPct.trim(), maxCycles: null,
  maxHours: d.maxHours.trim() ? Number(d.maxHours) : null,
});

function Field({ id, label, hint, value, onChange, suffix, placeholder }: {
  id: keyof Draft; label: string; hint?: string; value: string; onChange: (v: string) => void; suffix?: string; placeholder?: string;
}) {
  return (
    <div className="c-field">
      <label htmlFor={`series-${id}`}>{label}</label>
      <div className="relative">
        <input id={`series-${id}`} className="c-input num" inputMode="decimal" value={value} placeholder={placeholder}
               onChange={(e) => onChange(e.target.value)} style={suffix ? { paddingRight: 64 } : undefined} />
        {suffix && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px]" style={{ color: 'var(--muted)' }}>{suffix}</span>}
      </div>
      {hint && <p className="c-hint">{hint}</p>}
    </div>
  );
}

export function NewSeriesPage({ o, onStarted }: { o: SeriesOverview; onStarted: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft({ ...(o.series?.settings ?? o.defaults), basePrice: o.series?.settings.basePrice ?? null }));
  const [preview, setPreview] = useState<SeriesPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const nextLabel = seriesLabelFor((o.history[0]?.seriesNo ?? 0) + 1);

  // Live preview of the exact orders these settings would place (debounced).
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const { data } = await previewSeries(fromDraft(draft));
        setPreview(data);
        setPreviewError(null);
      } catch (e) {
        setPreview(null);
        setPreviewError(errorMessage(e, 'These settings are not valid.'));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [draft]);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      if (o.running) await stopSeries();
      await startSeries(fromDraft(draft));
      onStarted();
    } catch (e) {
      setError(errorMessage(e, 'The series could not start.'));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (o.running) setConfirm(true);
    else void begin();
  }

  const current = o.series;
  return (
    <div className="c-grid-main">
      <Card title={`Series ${nextLabel}`} sub="Set the base and press start. Every order is a post-only limit order; nothing is sent at market.">
        <form onSubmit={submit} className="grid gap-7">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field id="basePrice" label="Base price" placeholder={o.marketPrice ? `${o.marketPrice} (market)` : 'market price'} value={draft.basePrice} onChange={set('basePrice')} suffix="USDT"
                   hint="Nothing trades at the base. Empty uses the market price at start." />
            <Field id="totalZig" label="Total ZIG" value={draft.totalZig} onChange={set('totalZig')} suffix="ZIG" />
            <Field id="sellPct" label="Share of ZIG for sale" value={draft.sellPct} onChange={set('sellPct')} suffix="%" hint="100% puts all of it into the sells." />
            <Field id="orders" label="Number of sell orders" value={draft.orders} onChange={set('orders')} />
            <Field id="firstSellPct" label="First sell above base" value={draft.firstSellPct} onChange={set('firstSellPct')} suffix="%" />
            <Field id="stepPct" label="Each next sell above the last" value={draft.stepPct} onChange={set('stepPct')} suffix="%" />
            <Field id="buybackPct" label="Buyback below each filled sell" value={draft.buybackPct} onChange={set('buybackPct')} suffix="%" />
            <Field id="resellPct" label="Re-sell above each filled buyback" value={draft.resellPct} onChange={set('resellPct')} suffix="%" />
            <Field id="maxHours" label="Stop by itself after" value={draft.maxHours} onChange={set('maxHours')} suffix="hours" placeholder="never" hint="Optional. Empty runs until you stop it." />
          </div>
          {previewError && <p className="c-error" role="alert">{previewError}</p>}
          {error && <p className="c-error" role="alert">{error}</p>}
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" className="c-btn c-btn-primary" disabled={busy || !!previewError || !preview}>
              {busy ? 'Starting…' : o.running && current ? `Stop Series ${current.label} and start Series ${nextLabel}` : `Start Series ${nextLabel}`}
            </button>
            <span className="text-[13px]" style={{ color: 'var(--muted)' }}>Paper trading on live Bybit prices. No real orders.</span>
          </div>
        </form>
        {confirm && current && (
          <ConfirmDialog
            title={`Replace Series ${current.label}?`}
            body={`Every order of Series ${current.label} is cancelled, its profit stays recorded, and Series ${nextLabel} starts at the new base.`}
            confirmLabel={`Start Series ${nextLabel}`}
            onConfirm={begin}
            onClose={() => setConfirm(false)}
          />
        )}
      </Card>

      <Card title="Orders it will place" sub={preview ? `Market ${price(preview.marketPrice)} · base ${price(preview.basePrice)}` : 'Fill in the settings to see the orders.'}>
        {preview && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 text-[13px]">
              <div className="s-mini"><span>Each order</span><b className="num">{qty(preview.qtyPerOrder)} ZIG</b></div>
              <div className="s-mini"><span>ZIG for sale</span><b className="num">{qty(preview.zigForSale)}</b></div>
              <div className="s-mini"><span>Profit per loop</span><b className="num" style={{ color: 'var(--profit-text)' }}>≈ {usd(preview.loopProfit)}</b></div>
              <div className="s-mini"><span>Above market</span><b className="num">{preview.aboveMarket} of {preview.orders.length}</b></div>
            </div>
            <div className="c-table-wrap" style={{ maxHeight: 520 }}>
              <table className="c-table">
                <thead><tr><th>Order</th><th className="r">Sell at</th><th className="r">USDT</th><th className="r">Buyback at</th></tr></thead>
                <tbody>
                  {preview.orders.map((r) => (
                    <tr key={r.slot}>
                      <td className="num strong">#{r.slot}</td>
                      <td className="r num" style={{ color: 'var(--sell)' }}>
                        {price(r.sellPrice)}
                        {r.restsAt !== r.sellPrice && <span className="block text-[11px]" style={{ color: 'var(--muted)' }}>rests at {price(r.restsAt)}</span>}
                      </td>
                      <td className="r num">{Number(r.value).toFixed(2)}</td>
                      <td className="r num" style={{ color: 'var(--buy)' }}>{price(r.buybackAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="c-hint mt-4">If the market is already above a sell, it rests at the market instead, never below its price. Each filled buyback re-sells {preview.resellPct}% above the price it bought at.</p>
          </>
        )}
      </Card>
    </div>
  );
}
