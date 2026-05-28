-- db/migrations/0012_classements_enrichissement.sql

ALTER TABLE core.classements ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.classements ADD COLUMN IF NOT EXISTS dernieres_rencontres TEXT;

ALTER TABLE core.classements ADD CONSTRAINT uq_classements_id_ffhb UNIQUE (id_ffhb);
