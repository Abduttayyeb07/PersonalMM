'use client';

import { FormEvent, useState } from 'react';
import { login } from '../lib/api';
import { useAuthStore } from '../store/auth';
import { errorMessage, errorStatus } from '../lib/engine';

/** Deliberately not a sign-up page: accounts are created by an administrator. */
export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await login(email, password);
      setAuth(data.email);
    } catch (err) {
      const status = errorStatus(err);
      setError(
        status === 401 ? 'That email and password do not match.'
          : status === 429 ? 'Too many attempts. Wait a minute, then try again.'
            : errorMessage(err, 'Cannot reach the server. Check that the backend is running.'),
      );
    } finally {
      setPassword('');
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="c-card grid w-full max-w-[940px] overflow-hidden md:grid-cols-[1.05fr_1fr]">
        <div className="hidden flex-col justify-between border-r p-12 md:flex" style={{ background: 'var(--raised)', borderColor: 'var(--line)' }}>
          <div>
            <div className="c-brand">
              <span className="c-brand-mark" aria-hidden>Z</span>
              <span className="c-brand-name">ZIG Grid<span className="c-brand-sub">Sell-first engine</span></span>
            </div>
            <p className="mt-9 text-[16px] leading-7" style={{ color: 'var(--ink-2)' }}>
              Sell ZIG into strength, buy the same quantity back lower, and keep the difference in USDT.
            </p>
          </div>
          <ul className="mt-10 space-y-5">
            {[
              ['Simulate first', 'Run the engine on live prices with simulated fills before risking anything.'],
              ['Your keys only', 'Trade-only keys, encrypted for your account. No withdrawals, ever.'],
              ['Stops when in doubt', 'Any mismatch cancels every order and waits for a human.'],
            ].map(([title, body]) => (
              <li key={title} className="flex gap-3.5">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--gold)' }} />
                <div>
                  <p className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</p>
                  <p className="mt-0.5 text-[13px] leading-6" style={{ color: 'var(--muted)' }}>{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="p-10 sm:p-12">
          <h1 className="display text-[28px] font-bold tracking-tight" style={{ color: 'var(--ink)' }}>Sign in</h1>
          <p className="mt-2 text-[15px]" style={{ color: 'var(--muted)' }}>Access your engine.</p>
          <form onSubmit={submit} className="mt-9 space-y-6">
            <div className="c-field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="username" required className="c-input" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="c-field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" required className="c-input" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <p role="alert" className="c-error">{error}</p>}
            <button type="submit" disabled={loading} className="c-btn c-btn-primary w-full">{loading ? 'Signing in…' : 'Sign in'}</button>
          </form>
          <p className="mt-8 border-t pt-5 text-[13px] leading-6" style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>
            Private workspace. Accounts are created by an administrator, and each one has its own keys, engine and data.
          </p>
        </div>
      </div>
    </main>
  );
}
