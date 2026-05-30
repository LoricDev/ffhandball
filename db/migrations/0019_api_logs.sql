-- db/migrations/0019_api_logs.sql
-- Historique des requêtes HTTP reçues par l'API.
-- key_prefix NULL = requête anonyme (auth désactivée ou chemin public).
CREATE TABLE IF NOT EXISTS core.api_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  method         text        NOT NULL,
  path           text        NOT NULL,
  status         integer     NOT NULL,
  duration_ms    integer     NOT NULL,
  ip             text,
  key_prefix     text
);

CREATE INDEX IF NOT EXISTS api_logs_requested_at_idx ON core.api_logs (requested_at DESC);
CREATE INDEX IF NOT EXISTS api_logs_key_prefix_idx   ON core.api_logs (key_prefix) WHERE key_prefix IS NOT NULL;
