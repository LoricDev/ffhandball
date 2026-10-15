-- db/migrations/0027_equipe_overrides.sql
-- Corrections manuelles du regroupement des équipes (?grouper=true de /clubs/:id/equipes).
--
-- Le regroupement est une heuristique sur les noms (src/api/lib/equipe-groupes.ts). Quand elle se trompe
-- (deux équipes aux noms identiques, coupe rattachée à la mauvaise équipe), on corrige ici, par
-- inscription FFHB. Chaque champ NULL = « laisser l'heuristique décider ». Les données de core.equipes
-- ne sont jamais modifiées : seule la présentation des groupes change.
CREATE TABLE IF NOT EXISTS core.equipe_overrides (
  equipe_id_ffhb text        PRIMARY KEY,                -- core.equipes.id_ffhb (une inscription)
  categorie      text        CHECK (categorie IN ('Seniors','-20','-19','-18','-17','-15','-13','-11','-9','-7','Loisir','Autre')),
  sexe           text        CHECK (sexe IN ('M','F','mixte')),
  rang           integer     CHECK (rang BETWEEN 1 AND 9),
  entente        boolean,
  exclu          boolean     NOT NULL DEFAULT false,      -- true = absente des groupes (reste dans data)
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
