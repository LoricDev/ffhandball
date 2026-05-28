-- db/migrations/0013_stats_joueurs.sql

-- 1. Raw table
SELECT raw._create_capture_table('stats_joueurs');

-- 2. Core table (nouvelle)
CREATE TABLE IF NOT EXISTS core.stats_joueurs (
  id             bigserial PRIMARY KEY,
  poule_id       bigint NOT NULL REFERENCES core.poules(id) ON DELETE CASCADE,
  individu_id    text NOT NULL,
  nom            text NOT NULL,
  prenom         text NOT NULL,
  equipe_id      bigint REFERENCES core.equipes(id),
  equipe_libelle text NOT NULL,
  match_count    integer NOT NULL DEFAULT 0,
  total_buts     integer NOT NULL DEFAULT 0,
  total_arrets   integer NOT NULL DEFAULT 0,
  saison_code    text NOT NULL REFERENCES core.saisons(saison_code),
  capture_date   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_stats_joueurs_poule_individu UNIQUE (poule_id, individu_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_joueurs_poule       ON core.stats_joueurs (poule_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_equipe      ON core.stats_joueurs (equipe_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_individu    ON core.stats_joueurs (individu_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_total_buts  ON core.stats_joueurs (total_buts DESC) WHERE total_buts > 0;
