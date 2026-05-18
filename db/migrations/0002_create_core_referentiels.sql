-- 0002_create_core_referentiels.sql
-- Schéma core : référentiels (saisons, ligues, départements, salles)

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.saisons (
  saison_code     text PRIMARY KEY,
  date_debut      date NOT NULL,
  date_fin        date NOT NULL,
  CHECK (saison_code ~ '^\d{4}-\d{4}$'),
  CHECK (date_fin > date_debut)
);

CREATE TABLE IF NOT EXISTS core.ligues (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL,
  nom             text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ligues_code UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS core.departements (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL,
  nom             text NOT NULL,
  ligue_id        bigint REFERENCES core.ligues(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_departements_code UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS core.salles (
  id                bigserial PRIMARY KEY,
  id_ffhb           text NOT NULL,
  nom               text NOT NULL,
  adresse           text,
  code_postal       text,
  ville             text,
  departement_id    bigint REFERENCES core.departements(id),
  capacite          integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_salles_id_ffhb UNIQUE (id_ffhb)
);

CREATE INDEX IF NOT EXISTS idx_departements_ligue ON core.departements (ligue_id);
CREATE INDEX IF NOT EXISTS idx_salles_departement ON core.salles (departement_id);
