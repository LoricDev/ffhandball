-- db/migrations/0024_cron_runs.sql
-- Suivi des crons (jusqu'ici invisibles en base : seuls leurs scrapes/ETL l'étaient).
-- Alimenté par deploy/cron/lib-cron.sh via `pnpm cron-run`. Sert au tableau de bord admin.
CREATE TABLE IF NOT EXISTS core.cron_runs (
  id            bigserial PRIMARY KEY,
  cron          text        NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text        NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  steps_total   integer     NOT NULL DEFAULT 0,
  step_index    integer     NOT NULL DEFAULT 0,
  current_step  text,
  errors        integer     NOT NULL DEFAULT 0,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_cron_started ON core.cron_runs (cron, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_running ON core.cron_runs (status) WHERE status = 'running';
