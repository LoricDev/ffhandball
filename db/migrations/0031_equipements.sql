-- db/migrations/0031_equipements.sql
-- Équipements (salles) tels que nommés par les feuilles de match, clés par l'`equipementId` de
-- la liste des rencontres (= core.matchs.equipement_id). Ce ne sont pas les salles de core.salles
-- (slug nom+code postal+ville, issu des fiches clubs) : aucune clé commune n'existe entre les deux.
CREATE TABLE IF NOT EXISTS core.equipements (
  equipement_id text PRIMARY KEY,
  nom           text NOT NULL,
  adresse       text,
  code_postal   text,
  ville         text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Première alimentation depuis les feuilles de match déjà capturées. Le rafraîchissement courant est
-- fait par refreshEquipements() (src/etl/equipements.etl.ts) à la fin de l'ETL des feuilles de match :
-- garder les deux requêtes identiques.
INSERT INTO core.equipements (equipement_id, nom, adresse, code_postal, ville)
SELECT DISTINCT ON (equipement_id)
       equipement_id, nom, adresse,
       (regexp_match(adresse, '(\d{5})\s+(.+)$'))[1],
       (regexp_match(adresse, '(\d{5})\s+(.+)$'))[2]
  FROM (
    SELECT m.equipement_id, f.payload->>'salle_libelle' AS nom, f.payload->>'salle_adresse' AS adresse, count(*) AS n
      FROM core.matchs m
      JOIN raw.feuilles_match f ON f.payload->>'fdm_code' = m.fdm_code
     WHERE m.equipement_id IS NOT NULL AND f.payload->>'salle_libelle' IS NOT NULL
     GROUP BY 1, 2, 3
  ) s
 ORDER BY equipement_id, n DESC
ON CONFLICT (equipement_id) DO NOTHING;
