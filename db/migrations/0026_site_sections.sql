-- db/migrations/0026_site_sections.sql
-- Sections de compétitions annoncées par ffhandball.fr (champ available_types : national, regional,
-- departemental, coupe-de-france…) et ce que le scrape en a réellement lu, à chaque run.
--
-- Pourquoi : la Coupe de France (section à part) n'a jamais été scrapée parce que le scraper visitait
-- 3 adresses codées en dur et que rien ne comparait ce que le site annonce à ce qu'on lit. Le monitor
-- lit cette table pour alerter si une section annoncée n'a pas été visitée ou est revenue vide.
CREATE TABLE IF NOT EXISTS raw.site_sections (
  id            bigserial PRIMARY KEY,
  scrape_run_id uuid        NOT NULL REFERENCES raw.scrape_runs(id) ON DELETE CASCADE,
  saison        text        NOT NULL,
  section       text        NOT NULL,                 -- segment d'URL : 'national', 'coupe-de-france'…
  announced     boolean     NOT NULL DEFAULT true,    -- présente dans available_types du site
  crawled       boolean     NOT NULL DEFAULT false,   -- page lue avec succès
  competitions  integer     NOT NULL DEFAULT 0,       -- compétitions lues dans cette section
  note          text,                                 -- raison d'un échec ou d'une anomalie
  seen_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_site_sections_run UNIQUE (scrape_run_id, section)
);

CREATE INDEX IF NOT EXISTS idx_site_sections_saison_seen ON raw.site_sections (saison, seen_at DESC);
