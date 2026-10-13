'use client';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { listCredentials } from '../lib/api';
import LoginForm from '../components/LoginForm';
import SeriesConsole from '../components/series/SeriesConsole';

type AppState = 'loading' | 'auth' | 'dashboard';

export default function Home() {
  const { email, ready, hydrate } = useAuthStore();
  const [appState, setAppState] = useState<AppState>('loading');

  // On mount: call /auth/me via hydrate — sets ready=true when done
  useEffect(() => {
    hydrate();
  }, []);

  // Once hydrate resolves, decide which screen to show
  useEffect(() => {
    if (!ready) return;
    if (!email) {
      setAppState('auth');
      return;
    }
    listCredentials()
      .then(() => setAppState('dashboard'))
      .catch(() => {
        useAuthStore.getState().logout();
        setAppState('auth');
      });
  }, [ready, email]);

  if (appState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[15px]" style={{ color: 'var(--muted)' }} role="status">Loading your engine…</p>
      </div>
    );
  }

  if (appState === 'auth') return <LoginForm />;
  return <SeriesConsole />;
}
