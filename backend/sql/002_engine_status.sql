-- Latest heartbeat of each engine instance, written by the runner every few seconds.
-- The dashboard reads it to show what the engine is doing right now.
CREATE TABLE engine_status (
  pair_id    text PRIMARY KEY,
  status     text NOT NULL,
  reason     text,
  snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
