// src/api/lib/repositories/stats-joueurs.repo.ts
import { query } from "@/db/client.js";

export interface StatsJoueurItem {
  nom: string;
  prenom: string;
  equipe_libelle: string | null;
  match_count: number;
  total_buts: number;
  total_arrets: number;
}

/**
 * Classement des stats joueurs d'une poule, sur le dernier snapshot (max capture_date),
 * ordonné par buts décroissants. Retourne {data,total}.
 */
export async function getStatsJoueursByPoule(
  pouleIdFfhb: string,
  limit: number,
  offset: number,
): Promise<{ data: StatsJoueurItem[]; total: number }> {
  const latest = `(
    SELECT max(sj2.capture_date)
      FROM core.stats_joueurs sj2
      JOIN core.poules po2 ON po2.id = sj2.poule_id
     WHERE po2.id_ffhb = $1
  )`;

  const countRes = await query<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM core.stats_joueurs sj
       JOIN core.poules po ON po.id = sj.poule_id
      WHERE po.id_ffhb = $1 AND sj.capture_date = ${latest}`,
    [pouleIdFfhb],
  );
  const total = countRes.rows[0]!.total;

  const dataRes = await query<StatsJoueurItem>(
    `SELECT sj.nom, sj.prenom, sj.equipe_libelle, sj.match_count, sj.total_buts, sj.total_arrets
       FROM core.stats_joueurs sj
       JOIN core.poules po ON po.id = sj.poule_id
      WHERE po.id_ffhb = $1 AND sj.capture_date = ${latest}
      ORDER BY sj.total_buts DESC NULLS LAST, sj.nom ASC
      LIMIT $2 OFFSET $3`,
    [pouleIdFfhb, limit, offset],
  );
  return { data: dataRes.rows, total };
}
