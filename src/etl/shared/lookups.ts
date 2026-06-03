// src/etl/shared/lookups.ts — préchargement d'index de résolution FK en mémoire.
// Charger une fois `id_ffhb → id` dans une Map évite un SELECT par ligne dans les ETL
// (des centaines de milliers d'allers-retours DB sur une saison complète).
import { query } from "@/db/client.js";

export async function loadIdIndex(
  table: "poules" | "equipes",
  saison: string,
): Promise<Map<string, number>> {
  const r = await query<{ id_ffhb: string; id: number }>(
    `SELECT id_ffhb, id FROM core.${table} WHERE saison_code = $1`,
    [saison],
  );
  return new Map(r.rows.map((row) => [row.id_ffhb, row.id]));
}

/** Index nom d'équipe → id (résolution best-effort par libellé, ex. stats-joueurs). */
export async function loadEquipeNameIndex(saison: string): Promise<Map<string, number>> {
  const r = await query<{ nom: string; id: number }>(
    `SELECT nom, id FROM core.equipes WHERE saison_code = $1`,
    [saison],
  );
  // Doublons de nom éventuels : le dernier gagne (équivalent au LIMIT 1 arbitraire d'origine).
  return new Map(r.rows.map((row) => [row.nom, row.id]));
}

export interface MatchRef {
  id: number;
  equipe_dom_id: number;
  equipe_ext_id: number;
}

/** Index fdm_code → match (id + équipes), pour résoudre les feuilles de match sans N+1. */
export async function loadMatchByFdmIndex(): Promise<Map<string, MatchRef>> {
  const r = await query<{ fdm_code: string; id: number; equipe_dom_id: number; equipe_ext_id: number }>(
    `SELECT fdm_code, id, equipe_dom_id, equipe_ext_id
       FROM core.matchs WHERE fdm_code IS NOT NULL AND fdm_code <> ''`,
  );
  return new Map(
    r.rows.map((row) => [row.fdm_code, { id: row.id, equipe_dom_id: row.equipe_dom_id, equipe_ext_id: row.equipe_ext_id }]),
  );
}
