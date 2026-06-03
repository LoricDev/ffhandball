-- db/migrations/0020_scrape_runs_pages_total.sql
-- Total d'items attendus pour un scrape (poules, slugs, codes FdM…), renseigné au démarrage.
-- Permet à `pnpm status` d'afficher un % d'avancement pour un scrape EN COURS
-- (pages_scraped / pages_total), comme pour les ETL (rows_read / total).
ALTER TABLE raw.scrape_runs
  ADD COLUMN IF NOT EXISTS pages_total integer;
