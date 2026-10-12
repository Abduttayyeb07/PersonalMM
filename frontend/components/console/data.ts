'use client';

import { useCallback, useEffect, useState } from 'react';
import { EngineMode, EngineOverview, SimStatus, errorMessage, getEngineOverview, getSimulation } from '../../lib/engine';

/** Polls the user's engine overview for one mode every 5 s. */
export function useOverview(mode: EngineMode) {
  const [data, setData] = useState<EngineOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await getEngineOverview(mode);
      setData(data);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Could not reach the engine API'));
    }
  }, [mode]);

  useEffect(() => {
    // Polling subscription: the first fetch and every 5 s after it update state asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Never show one mode's numbers under another mode's label while the new mode loads.
  return { data: data?.mode === mode ? data : null, error, reload: load };
}

/** Polls the user's paper simulation status. */
export function useSimulation() {
  const [sim, setSim] = useState<SimStatus | null>(null);
  const load = useCallback(async () => {
    try {
      const { data } = await getSimulation();
      setSim(data);
    } catch { /* the overview already reports connectivity problems */ }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  return { sim, reload: load, setSim };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
