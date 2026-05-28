-- db/migrations/0015_feuilles_match_extensions.sql

-- 1. Étendre core.match_compositions : stats fines par joueur par match
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS type_licence TEXT;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS tirs_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS arrets_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS sept_metres_tentes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS sept_metres_reussis INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS avertissement BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS disqualifie BOOLEAN NOT NULL DEFAULT false;

-- 2. Étendre core.match_officiels : nouveaux rôles
ALTER TABLE core.match_officiels DROP CONSTRAINT IF EXISTS match_officiels_role_check;
ALTER TABLE core.match_officiels ADD CONSTRAINT match_officiels_role_check
  CHECK (role IN (
    'arbitre_1', 'arbitre_2',
    'delegue', 'observateur',
    'chrono', 'chronometreur', 'secretaire',
    'tuteur_table', 'juge_delegue', 'juge_arbitre_1', 'juge_arbitre_2', 'juge',
    'responsable_salle', 'speaker', 'delegue_officiel',
    'officiel_resp_a', 'officiel_b', 'officiel_c', 'officiel_d',
    'kine', 'medecin', 'accompagnateur'
  ));

-- 3. Créer core.match_actions (déroulé chronologique)
CREATE TABLE IF NOT EXISTS core.match_actions (
  id              bigserial PRIMARY KEY,
  match_id        bigint NOT NULL REFERENCES core.matchs(id) ON DELETE CASCADE,
  ordre           integer NOT NULL,
  periode         integer NOT NULL CHECK (periode BETWEEN 1 AND 4),
  temps_seconds   integer NOT NULL CHECK (temps_seconds >= 0),
  score_recevant  integer NOT NULL CHECK (score_recevant >= 0),
  score_visiteur  integer NOT NULL CHECK (score_visiteur >= 0),
  type_action     text NOT NULL CHECK (type_action IN (
    'but', 'tir', 'arret', 'avertissement',
    'exclusion_2min', 'disqualification',
    'temps_mort_recevant', 'temps_mort_visiteur',
    'protocole_commotion', 'autre'
  )),
  cote            text CHECK (cote IN ('recevant', 'visiteur')),
  joueur_id       bigint REFERENCES core.joueurs(id),
  numero_maillot  integer,
  acteur_role     text CHECK (acteur_role IN ('joueur', 'officiel')),
  description_brute text,
  CONSTRAINT uq_match_actions UNIQUE (match_id, ordre)
);
CREATE INDEX IF NOT EXISTS idx_match_actions_match  ON core.match_actions (match_id);
CREATE INDEX IF NOT EXISTS idx_match_actions_joueur ON core.match_actions (joueur_id);
CREATE INDEX IF NOT EXISTS idx_match_actions_type   ON core.match_actions (type_action);

-- 4. Étendre core.matchs : fdm_code + fdm_url
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_code TEXT;
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_url TEXT;
CREATE INDEX IF NOT EXISTS idx_matchs_fdm_code ON core.matchs (fdm_code);

-- 5. core.joueurs : aucune modification (schéma existant convient)
--    numero_licence NOT NULL UNIQUE, nom NOT NULL, prenom NOT NULL
