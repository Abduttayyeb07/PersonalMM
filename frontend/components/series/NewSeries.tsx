'use client';

import { FormEvent, useEffect, useState } from 'react';
import { errorMessage, usd } from '../../lib/engine';
import {
  PAIRS, SeriesDirection, SeriesMode, SeriesOverview, SeriesPreview, SeriesSettings, SeriesSymbol, SeriesVenue, pairFmt, previewSeries, seriesLabelFor, startLiveSeries, startSeries, venueName, words,
} from '../../lib/series';
import { Card } from '../console/ui';
import { useMexcBalances } from '../MexcBalances';

type Draft = Record<'basePrice' | 'totalZig' | 'startUsdt' | 'sellPct' | 'orders' | 'firstSellPct' | 'stepPct' | 'buybackPct' | 'resellPct' | 'maxHours', string> & {
  direction: SeriesDirection;
  symbol: SeriesSymbol;
  venue: SeriesVenue;
  dailyReset: boolean;
};

const toDraft = (s: SeriesSettings): Draft => ({
  direction: s.direction ?? 'SELL_FIRST',
  symbol: s.symbol ?? 'ZIGUSDT',
  venue: s.venue ?? 'BYBIT',
  basePrice: s.basePrice ?? '', totalZig: s.totalZig, startUsdt: s.startUsdt, sellPct: s.sellPct, orders: String(s.orders),
  firstSellPct: s.firstSellPct, stepPct: s.stepPct, buybackPct: s.buybackPct, resellPct: s.resellPct,
  maxHours: s.maxHours === null ? '' : String(s.maxHours),
  dailyReset: true,
});

const fromDraft = (d: Draft): SeriesSettings => ({
  symbol: d.symbol,
  venue: d.venue,
  direction: d.direction,
  totalZig: d.totalZig.trim() || '0', startUsdt: d.startUsdt.trim() || '0', basePrice: d.basePrice.trim() || null, sellPct: d.sellPct.trim(),
  orders: Number(d.orders), firstSellPct: d.firstSellPct.trim(), stepPct: d.stepPct.trim(),
  buybackPct: d.buybackPct.trim(), resellPct: d.resellPct.trim(), maxCycles: null,
  maxHours: d.maxHours.trim() ? Number(d.maxHours) : null,
  dailyReset: true,
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

/** Accepts what a percentage can become while typing: up to 2 digits, a point, up to 2 decimals. */
const PCT_PATTERN = /^\d{0,2}(\.\d{0,2})?$/;

function PctField({ id, label, value, onChange, presets }: {
  id: keyof Draft; label: string; value: string; onChange: (v: string) => void; presets: string[];
}) {
  return (
    <div className="c-field">
      <label htmlFor={`series-${id}`}>{label}</label>
      <div className="relative">
        <input id={`series-${id}`} className="c-input num" inputMode="decimal" value={value} style={{ paddingRight: 64 }}
               onChange={(e) => { const v = e.target.value.replace(',', '.'); if (PCT_PATTERN.test(v)) onChange(v); }} />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px]" style={{ color: 'var(--muted)' }}>%</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`${label}: quick values`}>
        {presets.map((p) => (
          <button key={p} type="button" className="s-chip num" aria-pressed={Number(value) === Number(p)} onClick={() => onChange(p)}>{p}%</button>
        ))}
      </div>
    </div>
  );
}

const FIRST_PRESETS = ['0.5', '1', '1.5', '2', '2.5', '3'];
const STEP_PRESETS = ['0.25', '0.5', '0.75', '1', '1.5', '2'];
const LOOP_PRESETS = ['1.5', '1.75', '1.9', '2', '2.5', '3'];

const directions = (asset: string): Array<{ id: SeriesDirection; title: string; line: string }> => [
  { id: 'SELL_FIRST', title: 'Sell first', line: `Start with ${asset}. Sells above the base; earns when ${asset} rises and comes back.` },
  { id: 'BUY_FIRST', title: 'Buy first', line: `Start with USDT. Buys below the base; earns when ${asset} dips and comes back.` },
];

export function NewSeriesPage({ o, onStarted }: { o: SeriesOverview; onStarted: (id: string) => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(o.defaults[o.pairs[0]?.symbol ?? 'ZIGUSDT'].SELL_FIRST));
  const [preview, setPreview] = useState<SeriesPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Real money is offered on the exchanges and pairs the server allows (MEXC ZIG/USDT for now).
  const liveOffered = o.live.venues.includes(o.venue);
  const [mode, setMode] = useState<SeriesMode>('paper');
  const [password, setPassword] = useState('');
  const isLive = liveOffered && mode === 'live';
  const account = useMexcBalances(isLive && o.live.hasMexcKey, 10_000);
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const nextLabel = seriesLabelFor(Math.max(0, ...o.runs.map((r) => r.seriesNo)) + 1);
  const fmt = pairFmt(draft.symbol);
  const w = words(draft.direction, fmt.asset);
  const full = isLive ? o.live.running > 0 : o.running >= o.maxRunning;
  const liveBlocked = isLive && (!o.live.hasMexcKey || !o.live.symbols.includes(draft.symbol) || !password);
  const market = o.markets[draft.symbol];
  const rec = o.defaults[draft.symbol][draft.direction];
  const isRecommended = draft.firstSellPct === rec.firstSellPct && draft.stepPct === rec.stepPct && draft.buybackPct === rec.buybackPct
    && draft.resellPct === rec.resellPct;
  const applyRecommended = () => setDraft((d) => ({
    ...d, firstSellPct: rec.firstSellPct, stepPct: rec.stepPct, buybackPct: rec.buybackPct, resellPct: rec.resellPct,
  }));

  // Switching direction or pair loads its starting amount and its recommended rates (from backtests
  // on real Bybit data); your auto-stop stays. A new pair also clears the base (a ZIG price means
  // nothing for BTC).
  function pick(symbol: SeriesSymbol, direction: SeriesDirection) {
    if (symbol === draft.symbol && direction === draft.direction) return;
    const defaults = toDraft(o.defaults[symbol][direction]);
    setDraft((d) => ({
      ...defaults,
      basePrice: symbol === d.symbol ? d.basePrice : '',
      maxHours: d.maxHours,
    }));
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
      const { data } = isLive ? await startLiveSeries(fromDraft(draft), password) : await startSeries(fromDraft(draft));
      setPassword('');
      onStarted(data.id);
    } catch (e) {
      setError(errorMessage(e, 'The series could not start.'));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!full) void begin();
  }

  const shown = preview?.direction === draft.direction && preview?.symbol === draft.symbol ? preview : null;
  return (
    <div className="c-grid-main">
      <Card title={`New ${venueName(o.venue)} simulation · Series ${nextLabel}`} sub={`Follows live ${venueName(o.venue)} prices, next to your other simulations, with its own paper wallet. ${o.running} of ${o.maxRunning} running on ${venueName(o.venue)}. Every order is a post-only limit order; nothing is sent at market.`}>
        <form onSubmit={submit} className="grid gap-7">
          {liveOffered && (
            <div className="c-segment" role="radiogroup" aria-label="Paper or real money">
              <button type="button" role="radio" id="series-mode-paper" aria-checked={mode === 'paper'} onClick={() => setMode('paper')}>Paper (simulated)</button>
              <button type="button" role="radio" id="series-mode-live" aria-checked={mode === 'live'} className="s-live-option"
                      onClick={() => { setMode('live'); if (!o.live.symbols.includes(draft.symbol)) pick(o.live.symbols[0], draft.direction); }}>
                LIVE · real money
              </button>
            </div>
          )}
          {isLive && (
            <div className="s-live-warning" role="alert">
              <b>Real orders on your MEXC account.</b>
              Post-only limit orders with your own API key, on {o.live.symbols.map((x) => PAIRS[x].label).join(', ')} only. One live series at a time;
              its wallet may be worth at most {o.live.maxUsdt} USDT, and your MEXC account must hold that amount free. Only this series&apos; orders
              are ever touched; your other coins and manual orders are left alone. Stop cancels its orders on MEXC at once.
              {!o.live.hasMexcKey && <span className="mt-2 block" style={{ color: 'var(--bad)' }}>Connect your MEXC API key under Exchange keys first.</span>}
              {o.live.running > 0 && <span className="mt-2 block" style={{ color: 'var(--bad)' }}>A live series is already running. Stop it first.</span>}
              {o.live.hasMexcKey && (
                <span className="mt-3 block num" style={{ color: 'var(--ink)' }}>
                  {account.error
                    ? <span style={{ color: 'var(--bad)' }}>{account.error}</span>
                    : account.rows
                      ? <>Your MEXC spot now: <b>{account.find('USDT').free.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT</b> free
                          {' · '}<b>{account.find(fmt.asset).free.toLocaleString('en-US', { maximumFractionDigits: 2 })} {fmt.asset}</b> free</>
                      : 'Reading your MEXC balances…'}
                </span>
              )}
              {account.rows && w.buy && account.find('USDT').free < Number(draft.startUsdt || 0) && (
                <span className="mt-2 block" style={{ color: 'var(--bad)' }}>Not enough free USDT on MEXC for {draft.startUsdt} USDT. Move USDT to Spot or lower the amount.</span>
              )}
              {account.rows && !w.buy && account.find(fmt.asset).free < Number(draft.totalZig || 0) && (
                <span className="mt-2 block" style={{ color: 'var(--bad)' }}>Not enough free {fmt.asset} on MEXC for {draft.totalZig}. Move {fmt.asset} to Spot or lower the amount.</span>
              )}
            </div>
          )}
          <div className="c-segment s-pairs" role="radiogroup" aria-label="Pair">
            {o.pairs.map((p) => p.symbol).filter((sym) => !isLive || o.live.symbols.includes(sym)).map((sym) => (
              <button key={sym} type="button" role="radio" id={`series-pair-${sym}`} aria-checked={draft.symbol === sym} onClick={() => pick(sym, draft.direction)}>
                {PAIRS[sym].label}
                {o.markets[sym] && <span className="num" style={{ marginLeft: 8, color: 'var(--muted)' }}>{pairFmt(sym).price(o.markets[sym]!)}</span>}
              </button>
            ))}
          </div>
          <div className="s-direction" role="radiogroup" aria-label="Which side opens each loop">
            {directions(fmt.asset).map((d) => (
              <button key={d.id} type="button" role="radio" aria-checked={draft.direction === d.id} id={`series-direction-${d.id}`}
                      className="s-direction-option" data-side={d.id === 'BUY_FIRST' ? 'BUY' : 'SELL'} onClick={() => pick(draft.symbol, d.id)}>
                <b>{d.title}</b>
                <span>{d.line}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[13px]" style={{ color: 'var(--muted)' }}>
            <button type="button" className="s-chip" aria-pressed={isRecommended} onClick={applyRecommended}>Use recommended rates</button>
            <span className="num">
              {fmt.label} {w.name.toLowerCase()}: first {rec.firstSellPct}% · step {rec.stepPct}% · {w.buy ? 'sell-back' : 'buyback'} {w.buy ? rec.resellPct : rec.buybackPct}% · {w.buy ? 're-buy' : 're-sell'} {w.buy ? rec.buybackPct : rec.resellPct}%
            </span>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field id="basePrice" label="Base price" placeholder={market ? `${market} (market)` : 'market price'} value={draft.basePrice} onChange={set('basePrice')} suffix="USDT"
                   hint="Nothing trades at the base. Empty uses the market price at start." />
            {w.buy
              ? <Field id="startUsdt" label="USDT to buy with" value={draft.startUsdt} onChange={set('startUsdt')} suffix="USDT" />
              : <Field id="totalZig" label={`Total ${fmt.asset}`} value={draft.totalZig} onChange={set('totalZig')} suffix={fmt.asset} />}
            <Field id="sellPct" label={w.buy ? 'Share of USDT used' : `Share of ${fmt.asset} for sale`} value={draft.sellPct} onChange={set('sellPct')} suffix="%"
                   hint={w.buy ? '100% spreads all of it over the buys.' : '100% puts all of it into the sells.'} />
            <Field id="orders" label={`Number of ${w.opening}`} value={draft.orders} onChange={set('orders')} />
            <PctField id="firstSellPct" label={w.buy ? 'First buy below base' : 'First sell above base'} value={draft.firstSellPct} onChange={set('firstSellPct')} presets={FIRST_PRESETS} />
            <PctField id="stepPct" label={w.buy ? 'Each next buy below the last' : 'Each next sell above the last'} value={draft.stepPct} onChange={set('stepPct')} presets={STEP_PRESETS} />
            {w.buy ? (
              <>
                <PctField id="resellPct" label="Sell-back above each filled buy" value={draft.resellPct} onChange={set('resellPct')} presets={LOOP_PRESETS} />
                <PctField id="buybackPct" label="Re-buy below each filled sell-back" value={draft.buybackPct} onChange={set('buybackPct')} presets={LOOP_PRESETS} />
              </>
            ) : (
              <>
                <PctField id="buybackPct" label="Buyback below each filled sell" value={draft.buybackPct} onChange={set('buybackPct')} presets={LOOP_PRESETS} />
                <PctField id="resellPct" label="Re-sell above each filled buyback" value={draft.resellPct} onChange={set('resellPct')} presets={LOOP_PRESETS} />
              </>
            )}
            <Field id="maxHours" label="Stop by itself after" value={draft.maxHours} onChange={set('maxHours')} suffix="hours" placeholder="never" hint="Optional. Empty runs until you stop it." />
            <div className="s-note sm:col-span-2">
              <span>
                <b>The base resets by itself every day at 12:00 midnight (Pakistan)</b>
                The base moves to the last 1-minute candle&apos;s close, every order is cancelled (open loops too) and a fresh ladder is placed from the new base.
                This happens for every simulation, whether you typed a base or left it empty, with nothing to approve.
                Same series: profit and loops keep adding up. Sold {fmt.asset} from a closed-early loop stays USDT; bought {fmt.asset} stays {fmt.asset}.
              </span>
            </div>
          </div>
          {previewError && <p className="c-error" role="alert">{previewError}</p>}
          {error && <p className="c-error" role="alert">{error}</p>}
          <div className="flex flex-wrap items-center gap-4">
            {isLive && (
              <div className="c-field w-full sm:max-w-[360px]">
                <label htmlFor="series-live-password">Your account password (to confirm real money)</label>
                <input id="series-live-password" type="password" autoComplete="current-password" className="c-input"
                       value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            <button type="submit" className={`c-btn ${isLive ? 'c-btn-danger' : 'c-btn-primary'}`} disabled={busy || full || liveBlocked || !!previewError || !shown}>
              {busy ? 'Starting…' : isLive ? `Start LIVE ${fmt.label} with real money (${w.name.toLowerCase()})` : `Start ${fmt.label} · Series ${nextLabel} (${w.name.toLowerCase()})`}
            </button>
            <span className="text-[13px]" style={{ color: full || isLive ? 'var(--bad)' : 'var(--muted)' }}>
              {isLive
                ? (full ? 'A live series is already running. Stop it first.' : 'Real orders on your MEXC account with your API key.')
                : full ? `${o.maxRunning} simulations are running on ${venueName(o.venue)}, the most at once. Stop one to start another.` : `Paper trading on live ${venueName(o.venue)} prices. No real orders.`}
            </span>
          </div>
        </form>
      </Card>

      <Card title="Orders it will place" sub={shown ? `${venueName(o.venue)} ${fmt.label} · ${w.name} · market ${fmt.price(shown.marketPrice)} · base ${fmt.price(shown.basePrice)} · maker fee ${shown.makerFeePct}%` : 'Fill in the settings to see the orders.'}>
        {shown && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 text-[13px]">
              <div className="s-mini"><span>Each order</span><b className="num">{fmt.amount(shown.qtyPerOrder)} {fmt.asset}</b></div>
              <div className="s-mini">
                <span>{w.buy ? 'USDT for the buys' : `${fmt.asset} for sale`}</span>
                <b className="num">{w.buy ? usd(shown.usdtForBuys) : fmt.amount(shown.zigForSale)}</b>
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
                        {fmt.price(r.price)}
                        {r.restsAt !== r.price && <span className="block text-[11px]" style={{ color: 'var(--muted)' }}>rests at {fmt.price(r.restsAt)}</span>}
                      </td>
                      <td className="r num">{Number(r.value).toFixed(2)}</td>
                      <td className="r num" style={{ color: r.side === 'BUY' ? 'var(--sell)' : 'var(--buy)' }}>{fmt.price(r.nextAt)}</td>
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
