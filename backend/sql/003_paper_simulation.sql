-- Per-user paper simulation settings: what the user chose on the Simulation page, and when the
-- current run started. One row per user; a user can only ever read or change their own.
CREATE TABLE engine_paper_settings (
  owner_id   text PRIMARY KEY,
  settings   jsonb NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
