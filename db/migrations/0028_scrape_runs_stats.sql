-- db/migrations/0028_scrape_runs_stats.sql
-- Compteurs libres d'un scrape (jsonb), lus par le récap quotidien. Premier usage : le rattrapage des
-- journées passées (--journees=manquantes) y consigne ce qui a été récupéré et ce qui reste à faire.
ALTER TABLE raw.scrape_runs ADD COLUMN IF NOT EXISTS stats jsonb;
