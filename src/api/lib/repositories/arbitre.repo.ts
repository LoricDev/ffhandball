// src/api/lib/repositories/arbitre.repo.ts
import { query } from "@/db/client.js";

export interface ArbitreListItem {
  id_ffhb: string | null;
  numero_licence: string | null;
  nom_complet: string | null;
  nom: string;
  prenom: string | null;
  niveau: string | null;
}

export interface ArbitreMatchItem {
  id_ffhb_match: string;
  date_heure: Date;
  role: string;
  equipe_dom_nom: string;
  equipe_ext_nom: string;
  poule_id_ffhb: string;
  competition_nom: string;
}

export interface ListArbitresOptions {
  q?: string;
  niveau?: string;
  limit: number;
  offset: number;
}

export async function listArbitres(
  opts: ListArbitresOptions,
): Promise<{ data: ArbitreListItem[]; total: number }> {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (opts.q && opts.q.length >= 2) {
    params.push(opts.q);
    where.push(`$${params.length} <% coalesce(a.nom_complet, a.nom)`);
  }
  if (opts.niveau) {
    params.push(opts.niveau);
    where.push(`a.niveau = $${params.length}`);
  }
  const whereClause = where.join(" AND ");

  const countRes = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM core.arbitres a WHERE ${whereClause}`,
    params,
  );
  const total = countRes.rows[0]!.total;

  params.push(opts.limit);
  params.push(opts.offset);
  const dataRes = await query<ArbitreListItem>(
    `SELECT a.id_ffhb, a.numero_licence, a.nom_complet, a.nom, a.prenom, a.niveau
       FROM core.arbitres a
      WHERE ${whereClause}
      ORDER BY coalesce(a.nom_complet, a.nom)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { data: dataRes.rows, total };
}

export async function getArbitreMatchs(
  idFfhb: string,
  limit: number,
  offset: number,
): Promise<{ data: ArbitreMatchItem[]; total: number } | null> {
  const arbRes = await query<{ id: bigint }>(
    `SELECT id FROM core.arbitres WHERE id_ffhb = $1`,
    [idFfhb],
  );
  if (arbRes.rowCount === 0) return null;
  const arbitreId = arbRes.rows[0]!.id;

  const countRes = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM core.match_officiels mo WHERE mo.arbitre_id = $1`,
    [arbitreId],
  );
  const total = countRes.rows[0]!.total;

  const dataRes = await query<ArbitreMatchItem>(
    `SELECT m.id_ffhb_match, m.date_heure, mo.role,
            ed.nom AS equipe_dom_nom, ee.nom AS equipe_ext_nom,
            po.id_ffhb AS poule_id_ffhb, c.nom AS competition_nom
       FROM core.match_officiels mo
       JOIN core.matchs m ON m.id = mo.match_id
       JOIN core.equipes ed ON ed.id = m.equipe_dom_id
       JOIN core.equipes ee ON ee.id = m.equipe_ext_id
       JOIN core.poules po ON po.id = m.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE mo.arbitre_id = $1
      ORDER BY m.date_heure ASC
      LIMIT $2 OFFSET $3`,
    [arbitreId, limit, offset],
  );
  return { data: dataRes.rows, total };
}

export interface ArbitreDetail extends ArbitreListItem {
  nb_matchs: number;
}

export async function getArbitreDetail(idFfhb: string): Promise<ArbitreDetail | null> {
  const r = await query<ArbitreDetail>(
    `SELECT a.id_ffhb, a.numero_licence, a.nom_complet, a.nom, a.prenom, a.niveau,
            (SELECT count(*)::int FROM core.match_officiels mo WHERE mo.arbitre_id = a.id) AS nb_matchs
       FROM core.arbitres a
      WHERE a.id_ffhb = $1`,
    [idFfhb],
  );
  if (r.rowCount === 0) return null;
  return r.rows[0]!;
}
