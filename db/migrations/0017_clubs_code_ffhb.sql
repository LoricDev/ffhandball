-- db/migrations/0017_clubs_code_ffhb.sql
-- Code FFHB 7 chiffres du club, dérivé du préfixe de l'email (5221105@ffhandball.net → 5221105).
-- = préfixe des numéros de licence = code affiché sur les feuilles de match.
-- Identifiant public alternatif à id_ffhb (qui vaut l'id_club monclub).
-- Colonne générée STORED : toujours cohérente avec email, sans intervention de l'ETL.
ALTER TABLE core.clubs
  ADD COLUMN IF NOT EXISTS code_ffhb text
  GENERATED ALWAYS AS (substring(email from '^([0-9]{7})@')) STORED;

CREATE INDEX IF NOT EXISTS idx_clubs_code_ffhb ON core.clubs (code_ffhb);
