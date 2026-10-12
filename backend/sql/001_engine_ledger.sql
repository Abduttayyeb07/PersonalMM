-- Sell-first grid engine ledger. Plain Postgres, no ORM.
-- Money values live inside jsonb as decimal STRINGS so no float ever touches them.

CREATE TABLE engine_genesis (
  pair_id    text PRIMARY KEY,
  data       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engine_rungs (
  pair_id    text NOT NULL,
  rung_key   text NOT NULL,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, rung_key)
);

-- Every fill (including internal netting bookings) is one immutable event. The rung table can be
-- rebuilt from these rows alone.
CREATE TABLE engine_fills (
  pair_id text   NOT NULL,
  fill_id text   NOT NULL,
  seq     bigserial,
  ts      bigint NOT NULL,
  data    jsonb  NOT NULL,
  PRIMARY KEY (pair_id, fill_id)
);
CREATE INDEX engine_fills_seq_idx ON engine_fills (pair_id, seq);

CREATE TABLE engine_cycles (
  id        bigserial PRIMARY KEY,
  pair_id   text NOT NULL,
  rung_key  text NOT NULL,
  cycle     integer NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  data      jsonb NOT NULL,
  UNIQUE (pair_id, rung_key, cycle)
);
CREATE INDEX engine_cycles_closed_idx ON engine_cycles (pair_id, closed_at);

-- A sweep is recorded AFTER a human has moved the profit; the engine never moves it.
CREATE TABLE engine_sweeps (
  id         bigserial PRIMARY KEY,
  pair_id    text NOT NULL,
  amount     text NOT NULL,
  approvers  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engine_leases (
  pair_id    text PRIMARY KEY,
  holder     text NOT NULL,
  epoch      bigint NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE engine_audit (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  pair_id text,
  kind    text NOT NULL,
  actor   text,
  detail  jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX engine_audit_pair_idx ON engine_audit (pair_id, ts);

-- The audit log is append-only: any UPDATE or DELETE is rejected by the database itself.
CREATE FUNCTION engine_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'engine_audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engine_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON engine_audit
  FOR EACH ROW EXECUTE FUNCTION engine_audit_immutable();

-- Kill switch requests. pair_id '*' stops every pair. Any team member may set it.
CREATE TABLE engine_control (
  pair_id      text PRIMARY KEY,
  killed       boolean NOT NULL DEFAULT false,
  requested_by text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
