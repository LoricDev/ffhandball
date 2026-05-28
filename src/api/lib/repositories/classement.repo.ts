// src/api/lib/repositories/classement.repo.ts
import { query } from "@/db/client.js";

export interface ClassementItem {
  position: number;
  points: number;
  joues: number;
  gagnes: number;
  nuls: number;
  perdus: number;
  buts_pour: number;
  buts_contre: number;
  difference: number;
  dernieres_rencontres: string | null;
  capture_date: Date;
  equipe_id_ffhb: string;
  equipe_nom: string;
}

export async function getClassementByPoule(pouleIdFfhb: string): Promise<ClassementItem[]> {
  const sql = `
    SELECT cl.position, cl.points, cl.joues, cl.gagnes, cl.nuls, cl.perdus,
           cl.buts_pour, cl.buts_contre, cl.difference,
           cl.dernieres_rencontres, cl.capture_date,
           e.id_ffhb AS equipe_id_ffhb, e.nom AS equipe_nom
      FROM core.classements cl
      JOIN core.poules po ON po.id = cl.poule_id
      JOIN core.equipes e ON e.id = cl.equipe_id
     WHERE po.id_ffhb = $1
     ORDER BY cl.position ASC`;
  const r = await query<ClassementItem>(sql, [pouleIdFfhb]);
  return r.rows;
}
