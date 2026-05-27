-- db/migrations/0008_competitions_phases_poules.sql

-- 1. Raw tables additionnelles
SELECT raw._create_capture_table('phases');
SELECT raw._create_capture_table('poules');

-- 2. Enrichir core.competitions
ALTER TABLE core.competitions ALTER COLUMN sexe DROP NOT NULL;
ALTER TABLE core.competitions ALTER COLUMN categorie_age DROP NOT NULL;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS ext_structure_id TEXT;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS detail_url TEXT;

-- 3. Supprimer core.poules (vide à ce stade — FK depuis core.engagements sera recréée plus bas)
DROP TABLE IF EXISTS core.poules CASCADE;

-- 4. Créer core.phases
CREATE TABLE IF NOT EXISTS core.phases (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  competition_id  bigint NOT NULL REFERENCES core.competitions(id),
  nom             text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_phases_id_ffhb_saison UNIQUE (id_ffhb, saison_code)
);
CREATE INDEX IF NOT EXISTS idx_phases_competition ON core.phases (competition_id);

-- 5. Re-créer core.poules avec FK vers phases
CREATE TABLE IF NOT EXISTS core.poules (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  phase_id        bigint NOT NULL REFERENCES core.phases(id),
  nom             text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_poules_id_ffhb_saison UNIQUE (id_ffhb, saison_code)
);
CREATE INDEX IF NOT EXISTS idx_poules_phase ON core.poules (phase_id);

-- 6. Recréer la FK core.engagements → core.poules (était cascade-dropped)
ALTER TABLE core.engagements
  ADD CONSTRAINT engagements_poule_id_fkey
  FOREIGN KEY (poule_id) REFERENCES core.poules(id);

-- 7. Recréer les FKs core.classements → core.poules et core.matchs → core.poules
--    (également cascade-dropped avec DROP TABLE core.poules CASCADE)
ALTER TABLE core.classements
  ADD CONSTRAINT classements_poule_id_fkey
  FOREIGN KEY (poule_id) REFERENCES core.poules(id);

ALTER TABLE core.matchs
  ADD CONSTRAINT matchs_poule_id_fkey
  FOREIGN KEY (poule_id) REFERENCES core.poules(id);
