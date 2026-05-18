-- 0003_create_core_structures.sql

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS core.clubs (
  id                      bigserial PRIMARY KEY,
  id_ffhb                 text NOT NULL,
  nom                     text NOT NULL,
  sigle                   text,
  ville                   text,
  departement_id          bigint REFERENCES core.departements(id),
  ligue_id                bigint REFERENCES core.ligues(id),
  salle_principale_id     bigint REFERENCES core.salles(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_clubs_id_ffhb UNIQUE (id_ffhb)
);

CREATE INDEX IF NOT EXISTS idx_clubs_departement ON core.clubs (departement_id);
CREATE INDEX IF NOT EXISTS idx_clubs_ligue        ON core.clubs (ligue_id);
CREATE INDEX IF NOT EXISTS idx_clubs_nom_trgm     ON core.clubs USING gin (nom gin_trgm_ops);

CREATE TABLE IF NOT EXISTS core.competitions (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  nom             text NOT NULL,
  niveau          text NOT NULL CHECK (niveau IN ('national','regional','departemental')),
  sexe            text NOT NULL CHECK (sexe IN ('M','F','mixte')),
  categorie_age   text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_competitions_id_ffhb UNIQUE (id_ffhb)
);

CREATE TABLE IF NOT EXISTS core.poules (
  id                bigserial PRIMARY KEY,
  competition_id    bigint NOT NULL REFERENCES core.competitions(id),
  code              text NOT NULL,
  nom               text NOT NULL,
  saison_code       text NOT NULL REFERENCES core.saisons(saison_code),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_poules_competition_code UNIQUE (competition_id, code)
);

CREATE TABLE IF NOT EXISTS core.equipes (
  id                bigserial PRIMARY KEY,
  club_id           bigint NOT NULL REFERENCES core.clubs(id),
  nom_equipe        text NOT NULL,
  sexe              text NOT NULL CHECK (sexe IN ('M','F','mixte')),
  categorie_age     text NOT NULL,
  saison_code       text NOT NULL REFERENCES core.saisons(saison_code),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_equipes_club_nom_saison UNIQUE (club_id, nom_equipe, saison_code)
);

CREATE TABLE IF NOT EXISTS core.engagements (
  equipe_id     bigint NOT NULL REFERENCES core.equipes(id),
  poule_id      bigint NOT NULL REFERENCES core.poules(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (equipe_id, poule_id)
);
