-- Daily reset: at a fixed time the base moves to the last candle's close and the whole ladder is
-- replaced. Loops left open at a reset stay as they are (sold ZIG stays USDT, bought ZIG stays ZIG);
-- carried_base / carried_quote keep that change so the balance checks still add up.
ALTER TABLE series_runs
  ADD COLUMN last_reset_at timestamptz,
  ADD COLUMN resets integer NOT NULL DEFAULT 0,
  ADD COLUMN carried_base numeric NOT NULL DEFAULT 0,
  ADD COLUMN carried_quote numeric NOT NULL DEFAULT 0;
