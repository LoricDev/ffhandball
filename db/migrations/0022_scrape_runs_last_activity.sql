-- db/migrations/0022_scrape_runs_last_activity.sql
-- Heartbeat d'un scrape : mis à jour à chaque page. Permet de distinguer un run réellement actif
-- d'un run « fantôme » (processus tué sans passer par finishFailure, statut resté 'running').
ALTER TABLE raw.scrape_runs
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

UPDATE raw.scrape_runs
   SET last_activity_at = COALESCE(finished_at, started_at)
 WHERE last_activity_at IS NULL;
