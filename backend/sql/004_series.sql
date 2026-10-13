-- Series engine: a user sets a base price, N sell orders go up the price ladder, and every filled
-- sell places a buyback (and every filled buyback a re-sell). One row per run ("Series A", "B"...).
-- Money values live inside jsonb as decimal STRINGS.

CREATE TABLE series_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      text NOT NULL,
  mode          text NOT NULL,               -- paper | backtest
  series_no     integer NOT NULL,            -- 1 = Series A, 2 = Series B ...
  settings      jsonb NOT NULL,
  base_price    text NOT NULL,
  qty           text NOT NULL,               -- base asset per order
  start_zig     text NOT NULL,
  start_usdt    text NOT NULL,
  status        text NOT NULL,               -- RUNNING | STOPPED
  status_reason text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  stopped_at    timestamptz,
  UNIQUE (owner_id, mode, series_no)
);
CREATE INDEX series_runs_owner_idx ON series_runs (owner_id, mode, series_no DESC);

CREATE TABLE series_slots (
  run_id     uuid NOT NULL REFERENCES series_runs(id) ON DELETE CASCADE,
  slot       integer NOT NULL,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, slot)
);

CREATE TABLE series_fills (
  run_id  uuid   NOT NULL REFERENCES series_runs(id) ON DELETE CASCADE,
  fill_id text   NOT NULL,
  seq     bigserial,
  ts      bigint NOT NULL,
  data    jsonb  NOT NULL,
  PRIMARY KEY (run_id, fill_id)
);
CREATE INDEX series_fills_seq_idx ON series_fills (run_id, seq);

CREATE TABLE series_cycles (
  id        bigserial PRIMARY KEY,
  run_id    uuid NOT NULL REFERENCES series_runs(id) ON DELETE CASCADE,
  slot      integer NOT NULL,
  cycle     integer NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  data      jsonb NOT NULL,
  UNIQUE (run_id, slot, cycle)
);
CREATE INDEX series_cycles_closed_idx ON series_cycles (run_id, closed_at);

-- Latest heartbeat for the dashboard.
CREATE TABLE series_status (
  run_id     uuid PRIMARY KEY REFERENCES series_runs(id) ON DELETE CASCADE,
  status     text NOT NULL,
  reason     text,
  snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Activity log. Append-only: UPDATE and DELETE are rejected by the database.
CREATE TABLE series_events (
  id     bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES series_runs(id) ON DELETE CASCADE,
  ts     timestamptz NOT NULL DEFAULT now(),
  kind   text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX series_events_idx ON series_events (run_id, id DESC);

CREATE FUNCTION series_events_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;  -- allow ON DELETE CASCADE from a deleted run
  RAISE EXCEPTION 'series_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER series_events_no_update_delete
  BEFORE UPDATE OR DELETE ON series_events
  FOR EACH ROW EXECUTE FUNCTION series_events_immutable();
