'use client';

import { FormEvent, useEffect, useState } from 'react';
import { listCredentials, removeCredentials, saveCredentials, testCredentials } from '../lib/api';
import { errorMessage } from '../lib/engine';
import { MexcBalances } from './MexcBalances';

type Exchange = 'bybit' | 'mexc';
type CredentialInfo = { exchange: Exchange; keyHint: string | null; createdAt: string; updatedAt: string };

const META: Record<Exchange, { name: string; note: string }> = {
  bybit: { name: 'Bybit', note: 'Spot. The grid engine trades here.' },
  mexc: { name: 'MEXC', note: 'Spot. Used for LIVE (real-money) series on ZIG/USDT.' },
};

/** Secret inputs never leave component state and are cleared after every submission. */
function SecretInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="c-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="password" value={value} onChange={(e) => onChange(e.target.value)}
             autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={256} className="c-input num" />
    </div>
  );
}

function ExchangeCard({ exchange, connected, refresh }: { exchange: Exchange; connected?: CredentialInfo; refresh: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const meta = META[exchange];

  function clearSecrets() {
    setApiKey(''); setApiSecret(''); setPassword(''); setConfirmed(false);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      await saveCredentials(exchange, apiKey, apiSecret, password, confirmed);
      setMessage('Connection verified and saved.');
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not verify this key.'));
    } finally {
      clearSecrets();
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true); setError(''); setMessage('');
    try {
      await testCredentials(exchange);
      setMessage('Connection test passed.');
    } catch (err) {
      setError(errorMessage(err, 'Connection test failed.'));
    } finally { setBusy(false); }
  }

  async function disconnect() {
    if (!disconnecting) { setDisconnecting(true); return; }
    if (!password) { setError('Enter your account password to disconnect.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      await removeCredentials(exchange, password);
      setDisconnecting(false);
      setMessage('Disconnected.');
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Disconnect failed.'));
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <section className="c-card c-card-pad">
      <header className="c-card-head">
        <div>
          <h2 className="c-card-title">{meta.name}</h2>
          <p className="c-card-sub">{meta.note}</p>
        </div>
        <span className="c-pill" style={{ color: connected ? 'var(--good)' : 'var(--muted)' }}>
          <i style={{ background: connected ? 'var(--good)' : 'var(--faint)' }} />{connected ? 'Connected' : 'Not connected'}
        </span>
      </header>

      <p className="mb-7 rounded-lg p-4 text-[14px] leading-6" style={{ background: 'var(--gold-wash)', border: '1px solid rgba(244,190,98,.25)', color: 'var(--ink-2)' }}>
        Create a <b style={{ color: 'var(--gold-soft)' }}>trade-only</b> key with <b style={{ color: 'var(--gold-soft)' }}>withdrawals disabled</b>, and whitelist this server&apos;s IP address.
      </p>

      {connected ? (
        <div className="space-y-5">
          <div className="rounded-lg p-4 text-[15px]" style={{ border: '1px solid var(--line)', color: 'var(--muted)' }}>
            Key <span className="num" style={{ color: 'var(--ink)' }}>{connected.keyHint ?? 'stored securely'}</span>
            <p className="mt-1 text-[13px]">Connected {new Date(connected.createdAt).toLocaleString()}</p>
          </div>
          {exchange === 'mexc' && <MexcBalances />}
          {disconnecting && <SecretInput id={`${exchange}-pw`} label="Account password" value={password} onChange={setPassword} />}
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={test} disabled={busy} className="c-btn c-btn-ghost">Test connection</button>
            <button type="button" onClick={disconnect} disabled={busy} className="c-btn c-btn-danger">{disconnecting ? 'Confirm disconnect' : 'Disconnect'}</button>
            {disconnecting && <button type="button" onClick={() => { setDisconnecting(false); setPassword(''); }} className="c-btn c-btn-ghost">Cancel</button>}
          </div>
        </div>
      ) : (
        <form onSubmit={connect} className="space-y-6">
          <SecretInput id={`${exchange}-key`} label="API key" value={apiKey} onChange={setApiKey} />
          <SecretInput id={`${exchange}-secret`} label="API secret" value={apiSecret} onChange={setApiSecret} />
          <SecretInput id={`${exchange}-account`} label="Your account password" value={password} onChange={setPassword} />
          {exchange === 'mexc' && (
            <label className="flex gap-3 text-[14px] leading-6" style={{ color: 'var(--ink-2)' }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} required className="mt-1.5" />
              <span>I confirmed withdrawals are disabled and IP whitelisting is on.</span>
            </label>
          )}
          <button type="submit" disabled={busy || (exchange === 'mexc' && !confirmed)} className="c-btn c-btn-primary w-full">
            {busy ? 'Verifying…' : 'Verify and connect'}
          </button>
        </form>
      )}
      {error && <p role="alert" className="c-error mt-6">{error}</p>}
      {message && <p className="mt-6 text-[14px]" style={{ color: 'var(--good)' }}>✓ {message}</p>}
    </section>
  );
}

export default function ConnectExchange() {
  const [credentials, setCredentials] = useState<CredentialInfo[]>([]);
  const [loadError, setLoadError] = useState('');

  async function refresh() {
    try {
      const { data } = await listCredentials();
      setCredentials(data);
      setLoadError('');
    } catch { setLoadError('Could not load connection status.'); }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, []);

  return (
    <div>
      {loadError && <p role="alert" className="c-error mb-6">{loadError}</p>}
      <div className="grid gap-7 lg:grid-cols-2">
        {(['bybit', 'mexc'] as Exchange[]).map((ex) => (
          <ExchangeCard key={ex} exchange={ex} connected={credentials.find((c) => c.exchange === ex)} refresh={refresh} />
        ))}
      </div>
    </div>
  );
}
