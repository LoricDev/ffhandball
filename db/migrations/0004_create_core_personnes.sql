-- 0004_create_core_personnes.sql

CREATE TABLE IF NOT EXISTS core.joueurs (
  id                bigserial PRIMARY KEY,
  numero_licence    text NOT NULL,
  nom               text NOT NULL,
  prenom            text NOT NULL,
  date_naissance    date,
  sexe              text CHECK (sexe IN ('M','F')),
  nationalite       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_joueurs_numero_licence UNIQUE (numero_licence)
);

CREATE TABLE IF NOT EXISTS core.licences (
  id                bigserial PRIMARY KEY,
  joueur_id         bigint NOT NULL REFERENCES core.joueurs(id),
  club_id           bigint NOT NULL REFERENCES core.clubs(id),
  saison_code       text   NOT NULL REFERENCES core.saisons(saison_code),
  categorie_age     text,
  type_licence      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_licences_joueur_saison UNIQUE (joueur_id, saison_code)
);

CREATE INDEX IF NOT EXISTS idx_licences_club_saison
  ON core.licences (club_id, saison_code);

CREATE TABLE IF NOT EXISTS core.arbitres (
  id                       bigserial PRIMARY KEY,
  numero_licence           text NOT NULL,
  nom                      text NOT NULL,
  prenom                   text NOT NULL,
  niveau                   text,
  club_rattachement_id     bigint REFERENCES core.clubs(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_arbitres_numero_licence UNIQUE (numero_licence)
);
