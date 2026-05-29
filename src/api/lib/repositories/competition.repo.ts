// src/api/lib/repositories/competition.repo.ts
import { query } from "@/db/client.js";
import { getClassementByPoule, type ClassementItem } from "@/api/lib/repositories/classement.repo.js";

export interface CompetitionListItem {
  id_ffhb: string;
  nom: string;
  niveau: string | null;
  sexe: string | null;
  categorie_age: string | null;
  code: string | null;
  saison_code: string;
}

export interface CompetitionDetail extends CompetitionListItem {
  phases: Array<{ id_ffhb: string; nom: string; poules: Array<{ id_ffhb: string; nom: string }> }>;
}

export interface PouleDetail {
  id_ffhb: string;
  nom: string;
  saison_code: string;
  phase: { id_ffhb: string; nom: string };
  competition: { id_ffhb: string; nom: string; niveau: string | null };
  classement: ClassementItem[];
}

export interface ListCompetitionsOptions {
  saison: string;
  niveau?: string;
  sexe?: string;
  q?: string;
  limit: number;
  offset: number;
}

export async function listCompetitions(
  opts: ListCompetitionsOptions,
): Promise<{ data: CompetitionListItem[]; total: number }> {
  const where: string[] = ["c.saison_code = $1"];
  const params: unknown[] = [opts.saison];

  if (opts.niveau) {
    params.push(opts.niveau);
    where.push(`c.niveau = $${params.length}`);
  }
  if (opts.sexe) {
    params.push(opts.sexe);
    where.push(`c.sexe = $${params.length}`);
  }
  if (opts.q && opts.q.length >= 2) {
    params.push(opts.q);
    where.push(`$${params.length} <% c.nom`);
  }
  const whereClause = where.join(" AND ");

  const countRes = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM core.competitions c WHERE ${whereClause}`,
    params,
  );
  const total = countRes.rows[0]!.total;

  params.push(opts.limit);
  params.push(opts.offset);
  const dataRes = await query<CompetitionListItem>(
    `SELECT c.id_ffhb, c.nom, c.niveau, c.sexe, c.categorie_age, c.code, c.saison_code
       FROM core.competitions c
      WHERE ${whereClause}
      ORDER BY c.nom
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { data: dataRes.rows, total };
}

export async function getCompetitionDetail(idFfhb: string): Promise<CompetitionDetail | null> {
  const compRes = await query<CompetitionListItem & { id: bigint }>(
    `SELECT id, id_ffhb, nom, niveau, sexe, categorie_age, code, saison_code
       FROM core.competitions WHERE id_ffhb = $1`,
    [idFfhb],
  );
  if (compRes.rowCount === 0) return null;
  const comp = compRes.rows[0]!;

  const rows = await query<{
    phase_id_ffhb: string;
    phase_nom: string;
    poule_id_ffhb: string | null;
    poule_nom: string | null;
  }>(
    `SELECT ph.id_ffhb AS phase_id_ffhb, ph.nom AS phase_nom,
            po.id_ffhb AS poule_id_ffhb, po.nom AS poule_nom
       FROM core.phases ph
       LEFT JOIN core.poules po ON po.phase_id = ph.id
      WHERE ph.competition_id = $1
      ORDER BY ph.nom, po.nom`,
    [comp.id],
  );

  const phaseMap = new Map<string, { id_ffhb: string; nom: string; poules: Array<{ id_ffhb: string; nom: string }> }>();
  for (const r of rows.rows) {
    let phase = phaseMap.get(r.phase_id_ffhb);
    if (!phase) {
      phase = { id_ffhb: r.phase_id_ffhb, nom: r.phase_nom, poules: [] };
      phaseMap.set(r.phase_id_ffhb, phase);
    }
    if (r.poule_id_ffhb) phase.poules.push({ id_ffhb: r.poule_id_ffhb, nom: r.poule_nom ?? "" });
  }

  return {
    id_ffhb: comp.id_ffhb,
    nom: comp.nom,
    niveau: comp.niveau,
    sexe: comp.sexe,
    categorie_age: comp.categorie_age,
    code: comp.code,
    saison_code: comp.saison_code,
    phases: [...phaseMap.values()],
  };
}

export async function getPouleDetail(idFfhb: string, saison: string): Promise<PouleDetail | null> {
  const r = await query<{
    id_ffhb: string;
    nom: string;
    saison_code: string;
    phase_id_ffhb: string;
    phase_nom: string;
    comp_id_ffhb: string;
    comp_nom: string;
    comp_niveau: string | null;
  }>(
    `SELECT po.id_ffhb, po.nom, po.saison_code,
            ph.id_ffhb AS phase_id_ffhb, ph.nom AS phase_nom,
            c.id_ffhb AS comp_id_ffhb, c.nom AS comp_nom, c.niveau AS comp_niveau
       FROM core.poules po
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE po.id_ffhb = $1 AND po.saison_code = $2`,
    [idFfhb, saison],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  const classement = await getClassementByPoule(idFfhb);

  return {
    id_ffhb: row.id_ffhb,
    nom: row.nom,
    saison_code: row.saison_code,
    phase: { id_ffhb: row.phase_id_ffhb, nom: row.phase_nom },
    competition: { id_ffhb: row.comp_id_ffhb, nom: row.comp_nom, niveau: row.comp_niveau },
    classement,
  };
}
