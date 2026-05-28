-- db/migrations/0014_competitions_afficher_stats_joueurs.sql

ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS afficher_stats_joueurs BOOLEAN;
CREATE INDEX IF NOT EXISTS idx_competitions_afficher_stats_joueurs
  ON core.competitions (afficher_stats_joueurs)
  WHERE afficher_stats_joueurs = true;
