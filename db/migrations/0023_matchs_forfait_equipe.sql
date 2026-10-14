-- db/migrations/0023_matchs_forfait_equipe.sql
-- Équipe ayant fait forfait ('dom' | 'ext'), NULL si pas de forfait.
-- Source : la liste des rencontres ffhandball.fr affiche « FO » comme score de l'équipe forfait.
ALTER TABLE core.matchs
  ADD COLUMN IF NOT EXISTS forfait_equipe text CHECK (forfait_equipe IN ('dom', 'ext'));
