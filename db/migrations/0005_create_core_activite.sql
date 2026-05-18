-- 0005_create_core_activite.sql

CREATE TABLE IF NOT EXISTS core.matchs (
  id                bigserial PRIMARY KEY,
  id_ffhb_match     text NOT NULL,
  poule_id          bigint NOT NULL REFERENCES core.poules(id),
  equipe_dom_id     bigint NOT NULL REFERENCES core.equipes(id),
  equipe_ext_id     bigint NOT NULL REFERENCES core.equipes(id),
  date_heure        timestamptz NOT NULL,
  heure_estimee     boolean NOT NULL DEFAULT false,
  salle_id          bigint REFERENCES core.salles(id),
  score_dom         integer,
  score_ext         integer,
  score_mt_dom      integer,
  score_mt_ext      integer,
  statut            text NOT NULL DEFAULT 'a_jouer'
                    CHECK (statut IN ('a_jouer','joue','reporte','annule','forfait')),
  journee           integer,
  feuille_validee   boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_matchs_id_ffhb UNIQUE (id_ffhb_match),
  CONSTRAINT chk_matchs_equipes_distinctes CHECK (equipe_dom_id <> equipe_ext_id)
);

CREATE INDEX IF NOT EXISTS idx_matchs_poule_date
  ON core.matchs (poule_id, date_heure);
CREATE INDEX IF NOT EXISTS idx_matchs_equipe_dom ON core.matchs (equipe_dom_id);
CREATE INDEX IF NOT EXISTS idx_matchs_equipe_ext ON core.matchs (equipe_ext_id);

CREATE TABLE IF NOT EXISTS core.match_compositions (
  id                        bigserial PRIMARY KEY,
  match_id                  bigint NOT NULL REFERENCES core.matchs(id) ON DELETE CASCADE,
  joueur_id                 bigint NOT NULL REFERENCES core.joueurs(id),
  equipe_id                 bigint NOT NULL REFERENCES core.equipes(id),
  numero_maillot            integer,
  titulaire                 boolean NOT NULL DEFAULT false,
  capitaine                 boolean NOT NULL DEFAULT false,
  gardien                   boolean NOT NULL DEFAULT false,
  but_count                 integer NOT NULL DEFAULT 0,
  exclusion_2min_count      integer NOT NULL DEFAULT 0,
  carton_jaune              boolean NOT NULL DEFAULT false,
  carton_rouge              boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_match_compositions UNIQUE (match_id, joueur_id)
);

CREATE TABLE IF NOT EXISTS core.match_officiels (
  id              bigserial PRIMARY KEY,
  match_id        bigint NOT NULL REFERENCES core.matchs(id) ON DELETE CASCADE,
  arbitre_id      bigint NOT NULL REFERENCES core.arbitres(id),
  role            text NOT NULL
                  CHECK (role IN ('arbitre_1','arbitre_2','delegue','observateur','chrono')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_match_officiels UNIQUE (match_id, arbitre_id, role)
);

CREATE TABLE IF NOT EXISTS core.classements (
  poule_id          bigint NOT NULL REFERENCES core.poules(id),
  equipe_id         bigint NOT NULL REFERENCES core.equipes(id),
  position          integer NOT NULL,
  points            integer NOT NULL DEFAULT 0,
  joues             integer NOT NULL DEFAULT 0,
  gagnes            integer NOT NULL DEFAULT 0,
  nuls              integer NOT NULL DEFAULT 0,
  perdus            integer NOT NULL DEFAULT 0,
  buts_pour         integer NOT NULL DEFAULT 0,
  buts_contre       integer NOT NULL DEFAULT 0,
  difference        integer GENERATED ALWAYS AS (buts_pour - buts_contre) STORED,
  journee_courante  integer,
  capture_date      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poule_id, equipe_id)
);
