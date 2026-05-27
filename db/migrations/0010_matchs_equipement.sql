-- db/migrations/0010_matchs_equipement.sql

-- raw.matchs existe déjà (migration 0001)
-- core.matchs existe déjà (migration 0005)

ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS equipement_id TEXT;
CREATE INDEX IF NOT EXISTS idx_matchs_equipement_id ON core.matchs (equipement_id);
