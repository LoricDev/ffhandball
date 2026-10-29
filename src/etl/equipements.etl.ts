// src/etl/equipements.etl.ts — core.equipements : nom/adresse des salles d'après les feuilles de match.
// La liste des rencontres ne donne que `equipementId` ; la feuille de match (raw.feuilles_match) donne le
// nom et l'adresse. Par équipement on garde le couple (nom, adresse) le plus fréquent.
import { query } from "@/db/client.js";

/** Même requête que la première alimentation de db/migrations/0031_equipements.sql. */
export async function refreshEquipements(): Promise<number> {
  const r = await query(
    `INSERT INTO core.equipements (equipement_id, nom, adresse, code_postal, ville)
     SELECT DISTINCT ON (equipement_id)
            equipement_id, nom, adresse,
            (regexp_match(adresse, '(\\d{5})\\s+(.+)$'))[1],
            (regexp_match(adresse, '(\\d{5})\\s+(.+)$'))[2]
       FROM (
         SELECT m.equipement_id, f.payload->>'salle_libelle' AS nom, f.payload->>'salle_adresse' AS adresse, count(*) AS n
           FROM core.matchs m
           JOIN raw.feuilles_match f ON f.payload->>'fdm_code' = m.fdm_code
          WHERE m.equipement_id IS NOT NULL AND f.payload->>'salle_libelle' IS NOT NULL
          GROUP BY 1, 2, 3
       ) s
      ORDER BY equipement_id, n DESC
     ON CONFLICT (equipement_id) DO UPDATE
       SET nom = EXCLUDED.nom, adresse = EXCLUDED.adresse,
           code_postal = EXCLUDED.code_postal, ville = EXCLUDED.ville, updated_at = now()
     WHERE (core.equipements.nom, core.equipements.adresse)
           IS DISTINCT FROM (EXCLUDED.nom, EXCLUDED.adresse)`,
  );
  return r.rowCount ?? 0;
}
