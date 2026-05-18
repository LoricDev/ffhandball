-- 0006_create_core_etl_meta.sql

CREATE TABLE IF NOT EXISTS core.etl_runs (
  id                bigserial PRIMARY KEY,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  entity            text NOT NULL,
  saison            text,
  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','success','failed','partial')),
  rows_read         integer NOT NULL DEFAULT 0,
  rows_validated    integer NOT NULL DEFAULT 0,
  rows_rejected     integer NOT NULL DEFAULT 0,
  rows_inserted     integer NOT NULL DEFAULT 0,
  rows_updated      integer NOT NULL DEFAULT 0,
  rows_noop         integer NOT NULL DEFAULT 0,
  warnings_count    integer NOT NULL DEFAULT 0,
  error_message     text
);

CREATE INDEX IF NOT EXISTS idx_etl_runs_entity_started
  ON core.etl_runs (entity, started_at DESC);

CREATE TABLE IF NOT EXISTS core.etl_rejets (
  id              bigserial PRIMARY KEY,
  etl_run_id      bigint NOT NULL REFERENCES core.etl_runs(id),
  entity          text NOT NULL,
  raw_row_id      bigint,
  natural_key     text,
  payload         jsonb NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_etl_rejets_run ON core.etl_rejets (etl_run_id);

CREATE TABLE IF NOT EXISTS core.etl_warnings (
  id              bigserial PRIMARY KEY,
  etl_run_id      bigint NOT NULL REFERENCES core.etl_runs(id),
  entity          text NOT NULL,
  natural_key     text,
  message         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_etl_warnings_run ON core.etl_warnings (etl_run_id);

CREATE TABLE IF NOT EXISTS core.alias_clubs (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  alias           text NOT NULL,
  CONSTRAINT uq_alias_clubs UNIQUE (alias)
);

CREATE INDEX IF NOT EXISTS idx_alias_clubs_id_ffhb ON core.alias_clubs (id_ffhb);
