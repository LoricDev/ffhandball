// src/api/lib/repositories/salle.repo.ts
import { query } from "@/db/client.js";

export interface SalleDetail {
  id_ffhb: string;
  nom: string;
  adresse: string | null;
  code_postal: string | null;
  ville: string | null;
  departement_code: string | null;
  capacite: number | null;
}

export interface SalleMatchItem {
  id_ffhb_match: string;
  date_heure: Date;
  statut: string;
  journee: number | null;
  equipe_dom_nom: string;
  equipe_ext_nom: string;
  score_dom: number | null;
  score_ext: number | null;
  poule_id_ffhb: string;
  competition_nom: string;
  fdm_url: string | null;
}

export async function getSalleByIdFfhb(idFfhb: string): Promise<SalleDetail | null> {
  const r = await query<SalleDetail>(
    `SELECT s.id_ffhb, s.nom, s.adresse, s.code_postal, s.ville,
            d.code AS departement_code, s.capacite
       FROM core.salles s
       LEFT JOIN core.departements d ON d.id = s.departement_id
      WHERE s.id_ffhb = $1`,
    [idFfhb],
  );
  if (r.rowCount === 0) return null;
  return r.rows[0]!;
}

export interface SalleMatchsOptions {
  date_from?: string;
  date_to?: string;
  statut?: string;
  limit: number;
  offset: number;
}

export async function getSalleMatchs(
  idFfhb: string,
  opts: SalleMatchsOptions,
): Promise<{ data: SalleMatchItem[]; total: number } | null> {
  const sRes = await query<{ id: bigint }>(`SELECT id FROM core.salles WHERE id_ffhb = $1`, [idFfhb]);
  if (sRes.rowCount === 0) return null;
  const salleId = sRes.rows[0]!.id;

  const params: unknown[] = [salleId];
  const where: string[] = ["m.salle_id = $1"];
  if (opts.date_from) {
    params.push(opts.date_from);
    where.push(`m.date_heure >= $${params.length}::timestamptz`);
  }
  if (opts.date_to) {
    params.push(opts.date_to);
    where.push(`m.date_heure <= $${params.length}::timestamptz`);
  }
  if (opts.statut) {
    params.push(opts.statut);
    where.push(`m.statut = $${params.length}`);
  }
  const whereClause = where.join(" AND ");

  const countRes = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM core.matchs m WHERE ${whereClause}`,
    params,
  );
  const total = countRes.rows[0]!.total;

  params.push(opts.limit);
  params.push(opts.offset);
  const dataRes = await query<SalleMatchItem>(
    `SELECT m.id_ffhb_match, m.date_heure, m.statut, m.journee,
            ed.nom AS equipe_dom_nom, ee.nom AS equipe_ext_nom,
            m.score_dom, m.score_ext, po.id_ffhb AS poule_id_ffhb,
            c.nom AS competition_nom, m.fdm_url
       FROM core.matchs m
       JOIN core.equipes ed ON ed.id = m.equipe_dom_id
       JOIN core.equipes ee ON ee.id = m.equipe_ext_id
       JOIN core.poules po ON po.id = m.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE ${whereClause}
      ORDER BY m.date_heure ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { data: dataRes.rows, total };
}
