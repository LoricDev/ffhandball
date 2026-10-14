-- db/migrations/0022_scrape_runs_last_activity.sql
-- Heartbeat d'un scrape : mis à jour à chaque page. Permet de distinguer un run réellement actif
-- d'un run « fantôme » (processus tué sans passer par finishFailure, statut resté 'running').
ALTER TABLE raw.scrape_runs
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- Runs terminés : date de fin. Runs encore 'running' au moment de la migration : now() (délai de
-- grâce — un processus lancé avec l'ancien code ne met pas encore le heartbeat à jour).
UPDATE raw.scrape_runs
   SET last_activity_at = CASE WHEN status = 'running' THEN now() ELSE COALESCE(finished_at, started_at) END
 WHERE last_activity_at IS NULL;
