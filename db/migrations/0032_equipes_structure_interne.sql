-- db/migrations/0032_equipes_structure_interne.sql
-- Une entente de la saison courante n'a souvent pas d'`ext_structureId` (donc pas de club), alors que ses
-- inscriptions d'autres saisons en ont un. Elles partagent le `structureId` interne du site : on le garde,
-- puis on en déduit le club « porteur » (porteur_ext_structure_id = clubs.id_ffhb) quand ext_structure_id manque.
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS structure_interne_id text;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS porteur_ext_structure_id text;
CREATE INDEX IF NOT EXISTS idx_equipes_structure_interne ON core.equipes (structure_interne_id);
