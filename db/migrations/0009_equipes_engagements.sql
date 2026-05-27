-- db/migrations/0009_equipes_engagements.sql

-- 1. Raw table additionnelle (raw.equipes existe déjà depuis migration 0001)
SELECT raw._create_capture_table('engagements');

-- 2. Alter core.equipes
ALTER TABLE core.equipes DROP CONSTRAINT IF EXISTS uq_equipes_club_nom_saison;
ALTER TABLE core.equipes ALTER COLUMN club_id DROP NOT NULL;
ALTER TABLE core.equipes ALTER COLUMN sexe DROP NOT NULL;
ALTER TABLE core.equipes ALTER COLUMN categorie_age DROP NOT NULL;
ALTER TABLE core.equipes RENAME COLUMN nom_equipe TO nom;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS ext_structure_id TEXT;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS logo TEXT;

ALTER TABLE core.equipes ADD CONSTRAINT uq_equipes_id_ffhb_saison
  UNIQUE (id_ffhb, saison_code);

CREATE INDEX IF NOT EXISTS idx_equipes_club          ON core.equipes (club_id);
CREATE INDEX IF NOT EXISTS idx_equipes_ext_structure ON core.equipes (ext_structure_id);
CREATE INDEX IF NOT EXISTS idx_equipes_nom_trgm      ON core.equipes USING gin (nom gin_trgm_ops);
