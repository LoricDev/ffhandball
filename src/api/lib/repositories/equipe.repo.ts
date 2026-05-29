// src/api/lib/repositories/equipe.repo.ts
import { query } from "@/db/client.js";

export interface EngagementRef {
  poule: { id_ffhb: string; nom: string };
  phase: { id_ffhb: string; nom: string };
  competition: { id_ffhb: string; nom: string; niveau: string | null };
}

export interface EquipeDetail {
  id_ffhb: string;
  nom: string;
  saison_code: string;
  club: { id_ffhb: string; code_ffhb: string | null; nom: string } | null;
  engagements: EngagementRef[];
}

export interface EquipeMatchItem {
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

export interface ClubEquipe {
  id_ffhb: string;
  nom: string;
  engagements: EngagementRef[];
}

async function engagementsByEquipeIds(equipeIds: bigint[]): Promise<Map<string, EngagementRef[]>> {
  const map = new Map<string, EngagementRef[]>();
  if (equipeIds.length === 0) return map;
  const res = await query<{
    equipe_id: bigint;
    poule_id_ffhb: string;
    poule_nom: string;
    phase_id_ffhb: string;
    phase_nom: string;
    comp_id_ffhb: string;
    comp_nom: string;
    comp_niveau: string | null;
  }>(
    `SELECT en.equipe_id,
            po.id_ffhb AS poule_id_ffhb, po.nom AS poule_nom,
            ph.id_ffhb AS phase_id_ffhb, ph.nom AS phase_nom,
            c.id_ffhb AS comp_id_ffhb, c.nom AS comp_nom, c.niveau AS comp_niveau
       FROM core.engagements en
       JOIN core.poules po ON po.id = en.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE en.equipe_id = ANY($1)
      ORDER BY c.nom, po.nom`,
    [equipeIds],
  );
  for (const r of res.rows) {
    const key = r.equipe_id.toString();
    const arr = map.get(key) ?? [];
    arr.push({
      poule: { id_ffhb: r.poule_id_ffhb, nom: r.poule_nom },
      phase: { id_ffhb: r.phase_id_ffhb, nom: r.phase_nom },
      competition: { id_ffhb: r.comp_id_ffhb, nom: r.comp_nom, niveau: r.comp_niveau },
    });
    map.set(key, arr);
  }
  return map;
}

export async function getEquipeDetail(idFfhb: string, saison: string): Promise<EquipeDetail | null> {
  const eqRes = await query<{ id: bigint; id_ffhb: string; nom: string; saison_code: string; ext_structure_id: string | null }>(
    `SELECT id, id_ffhb, nom, saison_code, ext_structure_id
       FROM core.equipes WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  if (eqRes.rowCount === 0) return null;
  const eq = eqRes.rows[0]!;

  let club: EquipeDetail["club"] = null;
  if (eq.ext_structure_id) {
    const clubRes = await query<{ id_ffhb: string; code_ffhb: string | null; nom: string }>(
      `SELECT id_ffhb, code_ffhb, nom FROM core.clubs WHERE id_ffhb = $1`,
      [eq.ext_structure_id],
    );
    if (clubRes.rowCount! > 0) club = clubRes.rows[0]!;
  }

  const engagements = (await engagementsByEquipeIds([eq.id])).get(eq.id.toString()) ?? [];
  return { id_ffhb: eq.id_ffhb, nom: eq.nom, saison_code: eq.saison_code, club, engagements };
}

export interface EquipeMatchsOptions {
  date_from?: string;
  date_to?: string;
  statut?: string;
  limit: number;
  offset: number;
}

export async function getEquipeMatchs(
  idFfhb: string,
  saison: string,
  opts: EquipeMatchsOptions,
): Promise<{ data: EquipeMatchItem[]; total: number } | null> {
  const eqRes = await query<{ id: bigint }>(
    `SELECT id FROM core.equipes WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  if (eqRes.rowCount === 0) return null;
  const equipeId = eqRes.rows[0]!.id;

  const params: unknown[] = [equipeId];
  const where: string[] = ["(m.equipe_dom_id = $1 OR m.equipe_ext_id = $1)"];
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
  const dataRes = await query<EquipeMatchItem>(
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

export interface RosterJoueurItem {
  numero_licence: string;
  nom: string;
  prenom: string;
  matchs: number;
  buts: number;
}

/** Joueurs ayant joué pour une équipe (distincts, via match_compositions). null si équipe absente. */
export async function getEquipeJoueurs(idFfhb: string, saison: string): Promise<RosterJoueurItem[] | null> {
  const eqRes = await query<{ id: bigint }>(
    `SELECT id FROM core.equipes WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  if (eqRes.rowCount === 0) return null;
  const r = await query<RosterJoueurItem>(
    `SELECT j.numero_licence, j.nom, j.prenom,
            count(DISTINCT mc.match_id)::int AS matchs,
            coalesce(sum(mc.but_count), 0)::int AS buts
       FROM core.match_compositions mc
       JOIN core.joueurs j ON j.id = mc.joueur_id
      WHERE mc.equipe_id = $1
      GROUP BY j.id, j.numero_licence, j.nom, j.prenom
      ORDER BY buts DESC, j.nom ASC`,
    [eqRes.rows[0]!.id],
  );
  return r.rows;
}

/** Équipes propres d'un club (pont autoritatif ext_structure_id = clubs.id_ffhb). */
export async function listClubEquipes(clubIdFfhb: string, saison: string): Promise<ClubEquipe[]> {
  const eqRes = await query<{ id: bigint; id_ffhb: string; nom: string }>(
    `SELECT id, id_ffhb, nom FROM core.equipes
      WHERE ext_structure_id = $1 AND saison_code = $2
      ORDER BY nom`,
    [clubIdFfhb, saison],
  );
  const ids = eqRes.rows.map((r) => r.id);
  const engMap = await engagementsByEquipeIds(ids);
  return eqRes.rows.map((r) => ({
    id_ffhb: r.id_ffhb,
    nom: r.nom,
    engagements: engMap.get(r.id.toString()) ?? [],
  }));
}
