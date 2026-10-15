'use client';

import { FormEvent, useEffect, useState } from 'react';
import { errorMessage, price, qty, usd } from '../../lib/engine';
import {
  SeriesDirection, SeriesOverview, SeriesPreview, SeriesSettings, previewSeries, seriesLabelFor, startSeries, stopSeries, words,
} from '../../lib/series';
import { Card, ConfirmDialog } from '../console/ui';

type Draft = Record<'basePrice' | 'totalZig' | 'startUsdt' | 'sellPct' | 'orders' | 'firstSellPct' | 'stepPct' | 'buybackPct' | 'resellPct' | 'maxHours', string> & {
  direction: SeriesDirection;
};

const toDraft = (s: SeriesSettings): Draft => ({
  direction: s.direction ?? 'SELL_FIRST',
  basePrice: s.basePrice ?? '', totalZig: s.totalZig, startUsdt: s.startUsdt, sellPct: s.sellPct, orders: String(s.orders),
  firstSellPct: s.firstSellPct, stepPct: s.stepPct, buybackPct: s.buybackPct, resellPct: s.resellPct,
  maxHours: s.maxHours === null ? '' : String(s.maxHours),
});

const fromDraft = (d: Draft): SeriesSettings => ({
  direction: d.direction,
  totalZig: d.totalZig.trim() || '0', startUsdt: d.startUsdt.trim() || '0', basePrice: d.basePrice.trim() || null, sellPct: d.sellPct.trim(),
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

const DIRECTIONS: Array<{ id: SeriesDirection; title: string; line: string }> = [
  { id: 'SELL_FIRST', title: 'Sell first', line: 'Start with ZIG. Sells above the base; earns when ZIG rises and comes back.' },
  { id: 'BUY_FIRST', title: 'Buy first', line: 'Start with USDT. Buys below the base; earns when ZIG dips and comes back.' },
];

export function NewSeriesPage({ o, onStarted }: { o: SeriesOverview; onStarted: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(o.series?.settings ?? o.defaults));
  const [preview, setPreview] = useState<SeriesPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const nextLabel = seriesLabelFor((o.history[0]?.seriesNo ?? 0) + 1);
  const w = words(draft.direction);

  // Switching direction loads that direction's defaults, keeping the base price you typed.
  function pickDirection(direction: SeriesDirection) {
    if (direction === draft.direction) return;
    const defaults = direction === 'BUY_FIRST' ? o.buyFirstDefaults : o.defaults;
    setDraft((d) => ({ ...toDraft(defaults), basePrice: d.basePrice, maxHours: d.maxHours }));
  }

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
  const shown = preview?.direction === draft.direction ? preview : null;
  return (
    <div className="c-grid-main">
      <Card title={`Series ${nextLabel}`} sub="Choose which side opens each loop, set the base, and press start. Every order is a post-only limit order; nothing is sent at market.">
        <form onSubmit={submit} className="grid gap-7">
          <div className="s-direction" role="radiogroup" aria-label="Which side opens each loop">
            {DIRECTIONS.map((d) => (
              <button key={d.id} type="button" role="radio" aria-checked={draft.direction === d.id} id={`series-direction-${d.id}`}
                      className="s-direction-option" data-side={d.id === 'BUY_FIRST' ? 'BUY' : 'SELL'} onClick={() => pickDirection(d.id)}>
                <b>{d.title}</b>
                <span>{d.line}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field id="basePrice" label="Base price" placeholder={o.marketPrice ? `${o.marketPrice} (market)` : 'market price'} value={draft.basePrice} onChange={set('basePrice')} suffix="USDT"
                   hint="Nothing trades at the base. Empty uses the market price at start." />
            {w.buy
              ? <Field id="startUsdt" label="USDT to buy with" value={draft.startUsdt} onChange={set('startUsdt')} suffix="USDT" />
              : <Field id="totalZig" label="Total ZIG" value={draft.totalZig} onChange={set('totalZig')} suffix="ZIG" />}
            <Field id="sellPct" label={w.buy ? 'Share of USDT used' : 'Share of ZIG for sale'} value={draft.sellPct} onChange={set('sellPct')} suffix="%"
                   hint={w.buy ? '100% spreads all of it over the buys.' : '100% puts all of it into the sells.'} />
            <Field id="orders" label={`Number of ${w.opening}`} value={draft.orders} onChange={set('orders')} />
            <Field id="firstSellPct" label={w.buy ? 'First buy below base' : 'First sell above base'} value={draft.firstSellPct} onChange={set('firstSellPct')} suffix="%" />
            <Field id="stepPct" label={w.buy ? 'Each next buy below the last' : 'Each next sell above the last'} value={draft.stepPct} onChange={set('stepPct')} suffix="%" />
            {w.buy ? (
              <>
                <Field id="resellPct" label="Sell-back above each filled buy" value={draft.resellPct} onChange={set('resellPct')} suffix="%" />
                <Field id="buybackPct" label="Re-buy below each filled sell-back" value={draft.buybackPct} onChange={set('buybackPct')} suffix="%" />
              </>
            ) : (
              <>
                <Field id="buybackPct" label="Buyback below each filled sell" value={draft.buybackPct} onChange={set('buybackPct')} suffix="%" />
                <Field id="resellPct" label="Re-sell above each filled buyback" value={draft.resellPct} onChange={set('resellPct')} suffix="%" />
              </>
            )}
            <Field id="maxHours" label="Stop by itself after" value={draft.maxHours} onChange={set('maxHours')} suffix="hours" placeholder="never" hint="Optional. Empty runs until you stop it." />
          </div>
          {previewError && <p className="c-error" role="alert">{previewError}</p>}
          {error && <p className="c-error" role="alert">{error}</p>}
          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" className="c-btn c-btn-primary" disabled={busy || !!previewError || !shown}>
              {busy ? 'Starting…' : o.running && current ? `Stop Series ${current.label} and start Series ${nextLabel}` : `Start Series ${nextLabel} (${w.name.toLowerCase()})`}
            </button>
            <span className="text-[13px]" style={{ color: 'var(--muted)' }}>Paper trading on live Bybit prices. No real orders.</span>
          </div>
        </form>
        {confirm && current && (
          <ConfirmDialog
            title={`Replace Series ${current.label}?`}
            body={`Every order of Series ${current.label} is cancelled, its profit stays recorded, and Series ${nextLabel} starts (${w.name.toLowerCase()}) at the new base.`}
            confirmLabel={`Start Series ${nextLabel}`}
            onConfirm={begin}
            onClose={() => setConfirm(false)}
          />
        )}
      </Card>

      <Card title="Orders it will place" sub={shown ? `${w.name} · market ${price(shown.marketPrice)} · base ${price(shown.basePrice)}` : 'Fill in the settings to see the orders.'}>
        {shown && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 text-[13px]">
              <div className="s-mini"><span>Each order</span><b className="num">{qty(shown.qtyPerOrder)} ZIG</b></div>
              <div className="s-mini">
                <span>{w.buy ? 'USDT for the buys' : 'ZIG for sale'}</span>
                <b className="num">{w.buy ? usd(shown.usdtForBuys) : qty(shown.zigForSale)}</b>
              </div>
              <div className="s-mini"><span>Profit per loop</span><b className="num" style={{ color: 'var(--profit-text)' }}>≈ {usd(shown.loopProfit)}</b></div>
              <div className="s-mini"><span>{w.buy ? 'Below market' : 'Above market'}</span><b className="num">{shown.waitingForMarket} of {shown.orders.length}</b></div>
            </div>
            <div className="c-table-wrap" style={{ maxHeight: 520 }}>
              <table className="c-table">
                <thead><tr><th>Order</th><th className="r">{w.buy ? 'Buy at' : 'Sell at'}</th><th className="r">USDT</th><th className="r">{w.buy ? 'Sell-back at' : 'Buyback at'}</th></tr></thead>
                <tbody>
                  {shown.orders.map((r) => (
                    <tr key={r.slot}>
                      <td className="num strong">#{r.slot}</td>
                      <td className="r num" style={{ color: r.side === 'BUY' ? 'var(--buy)' : 'var(--sell)' }}>
                        {price(r.price)}
                        {r.restsAt !== r.price && <span className="block text-[11px]" style={{ color: 'var(--muted)' }}>rests at {price(r.restsAt)}</span>}
                      </td>
                      <td className="r num">{Number(r.value).toFixed(2)}</td>
                      <td className="r num" style={{ color: r.side === 'BUY' ? 'var(--sell)' : 'var(--buy)' }}>{price(r.nextAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="c-hint mt-4">
              {w.buy
                ? `If the market is already below a buy, it rests at the market instead, never above its price. Each filled sell-back re-buys ${shown.nextPct}% below the price it sold at.`
                : `If the market is already above a sell, it rests at the market instead, never below its price. Each filled buyback re-sells ${shown.nextPct}% above the price it bought at.`}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
