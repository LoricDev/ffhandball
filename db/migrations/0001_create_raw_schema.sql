-- 0001_create_raw_schema.sql
-- Schéma raw : capture brute append-only

CREATE SCHEMA IF NOT EXISTS raw;

CREATE TABLE IF NOT EXISTS raw.scrape_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  source_site     text NOT NULL,
  scraper_name    text NOT NULL,
  saison          text NOT NULL,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','success','failed','partial')),
  pages_scraped   integer NOT NULL DEFAULT 0,
  error_message   text
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_started_at
  ON raw.scrape_runs (started_at DESC);

CREATE OR REPLACE FUNCTION raw._create_capture_table(table_name text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS raw.%I (
      id              bigserial PRIMARY KEY,
      scrape_run_id   uuid NOT NULL REFERENCES raw.scrape_runs(id),
      source_url      text NOT NULL,
      source_site     text NOT NULL,
      natural_key     text NOT NULL,
      payload         jsonb NOT NULL,
      payload_hash    text NOT NULL,
      scraped_at      timestamptz NOT NULL DEFAULT now(),
      saison          text NOT NULL,
      http_status     integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_%I_nk_saison
      ON raw.%I (natural_key, saison);
    CREATE INDEX IF NOT EXISTS idx_%I_scrape_run
      ON raw.%I (scrape_run_id);
    CREATE INDEX IF NOT EXISTS idx_%I_payload_hash
      ON raw.%I (payload_hash);
    CREATE INDEX IF NOT EXISTS idx_%I_payload_gin
      ON raw.%I USING gin (payload);
  $f$, table_name, table_name, table_name, table_name, table_name,
       table_name, table_name, table_name, table_name);
END $$;

SELECT raw._create_capture_table('clubs');
SELECT raw._create_capture_table('equipes');
SELECT raw._create_capture_table('joueurs');
SELECT raw._create_capture_table('matchs');
SELECT raw._create_capture_table('feuilles_match');
SELECT raw._create_capture_table('classements');
SELECT raw._create_capture_table('competitions');
SELECT raw._create_capture_table('arbitres');
SELECT raw._create_capture_table('salles');
