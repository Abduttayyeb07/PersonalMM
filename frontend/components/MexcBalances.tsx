'use client';

import { useCallback, useEffect, useState } from 'react';
import { getMexcBalances, MexcBalance } from '../lib/api';
import { errorMessage } from '../lib/engine';

/** Polls the user's MEXC spot balances (read with their own key, never stored). */
export function useMexcBalances(enabled = true, everyMs = 15_000) {
  const [rows, setRows] = useState<MexcBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      const { data } = await getMexcBalances();
      setRows(data);
      setError(null);
      setAt(Date.now());
    } catch (e) {
      setError(errorMessage(e, 'Could not read your MEXC balances'));
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [enabled, everyMs, load]);
  const find = (asset: string) => rows?.find((r) => r.asset === asset) ?? { asset, free: 0, locked: 0 };
  return { rows, error, at, reload: load, find };
}

const fmt = (n: number, dp: number) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/**
 * The user's real MEXC spot account: USDT and ZIG first (free, in orders, total), then any other coin
 * they hold. Used on the key card and the live dashboard.
 */
export function MexcBalances({ zigPrice, title = 'Your MEXC spot balances' }: { zigPrice?: number | null; title?: string }) {
  const { rows, error, at, reload, find } = useMexcBalances();
  const usdt = find('USDT');
  const zig = find('ZIG');
  const others = (rows ?? []).filter((r) => r.asset !== 'USDT' && r.asset !== 'ZIG');
  const total = usdt.free + usdt.locked + (zigPrice ? (zig.free + zig.locked) * zigPrice : 0);
  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid var(--line)' }}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <b className="text-[14px]" style={{ color: 'var(--ink)' }}>{title}</b>
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
          {at ? `updated ${new Date(at).toLocaleTimeString()}` : 'loading…'} ·{' '}
          <button type="button" className="c-link" onClick={() => void reload()}>Refresh</button>
        </span>
      </div>
      {error && <p className="c-error mb-3">{error}</p>}
      <div className="c-table-wrap">
        <table className="c-table">
          <thead><tr><th>Coin</th><th className="r">Free</th><th className="r">In orders</th><th className="r">Total</th></tr></thead>
          <tbody>
            {[{ ...usdt, dp: 2 }, { ...zig, dp: 2 }].map((r) => (
              <tr key={r.asset}>
                <td className="strong">{r.asset}</td>
                <td className="r num strong">{fmt(r.free, r.dp)}</td>
                <td className="r num">{fmt(r.locked, r.dp)}</td>
                <td className="r num">{fmt(r.free + r.locked, r.dp)}</td>
              </tr>
            ))}
            {others.map((r) => (
              <tr key={r.asset}>
                <td>{r.asset}</td>
                <td className="r num">{r.free.toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
                <td className="r num">{r.locked.toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
                <td className="r num">{(r.free + r.locked).toLocaleString('en-US', { maximumFractionDigits: 8 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {zigPrice ? (
        <p className="c-hint mt-3">USDT + ZIG worth about <span className="num" style={{ color: 'var(--ink)' }}>${fmt(total, 2)}</span> at ZIG {zigPrice}.</p>
      ) : null}
    </div>
  );
}
