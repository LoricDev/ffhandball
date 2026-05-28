-- db/migrations/0011_arbitres_assouplissement.sql

ALTER TABLE core.arbitres ALTER COLUMN numero_licence DROP NOT NULL;
ALTER TABLE core.arbitres ALTER COLUMN prenom DROP NOT NULL;

ALTER TABLE core.arbitres ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.arbitres ADD COLUMN IF NOT EXISTS nom_complet TEXT;

ALTER TABLE core.arbitres ADD CONSTRAINT uq_arbitres_id_ffhb UNIQUE (id_ffhb);

CREATE INDEX IF NOT EXISTS idx_arbitres_nom_trgm
  ON core.arbitres USING gin (nom gin_trgm_ops);
