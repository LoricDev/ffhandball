-- db/migrations/0029_site_journees.sql
-- Journées annoncées par ffhandball.fr pour chaque poule (liste lue sur la page par défaut, à chaque scrape
-- des matchs). Sert à comparer « ce que le site a » à « ce que la base a » : journées déjà commencées
-- sur le site mais absentes (ou restées « à jouer ») dans core.matchs. Affiché dans le récap et l'admin.
CREATE TABLE IF NOT EXISTS raw.site_journees (
  saison         text        NOT NULL,
  poule_id_ffhb  text        NOT NULL,
  journee        integer     NOT NULL,
  date_debut     date,
  date_fin       date,
  seen_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (saison, poule_id_ffhb, journee)
);
CREATE INDEX IF NOT EXISTS idx_site_journees_debut ON raw.site_journees (saison, date_debut);
