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
