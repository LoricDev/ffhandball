// src/api/lib/repositories/joueur.repo.ts
import { query } from "@/db/client.js";

export interface JoueurDetail {
  numero_licence: string;
  nom: string;
  prenom: string;
  date_naissance: string | null;
  sexe: string | null;
  nationalite: string | null;
  stats: {
    total_buts: number;
    total_exclusions_2min: number;
    total_tirs: number;
    total_arrets: number;
    total_matchs: number;
  };
  historique: Array<{
    id_ffhb_match: string;
    date_heure: Date;
    equipe_dom_nom: string;
    equipe_ext_nom: string;
    score_dom: number | null;
    score_ext: number | null;
    equipe_joueur_nom: string;
    buts: number;
    tirs: number;
    arrets: number;
  }>;
}

export async function getJoueurByLicence(numeroLicence: string): Promise<JoueurDetail | null> {
  // 1. Joueur detail
  const joueurRes = await query<Record<string, unknown>>(
    `SELECT j.numero_licence, j.nom, j.prenom, j.date_naissance, j.sexe, j.nationalite
       FROM core.joueurs j
      WHERE j.numero_licence = $1`,
    [numeroLicence],
  );
  if (joueurRes.rowCount === 0) return null;
  const j = joueurRes.rows[0]!;

  // 2. Stats agrégées
  const statsRes = await query<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(mc.but_count), 0)::int AS total_buts,
       COALESCE(SUM(mc.exclusion_2min_count), 0)::int AS total_exclusions_2min,
       COALESCE(SUM(mc.tirs_count), 0)::int AS total_tirs,
       COALESCE(SUM(mc.arrets_count), 0)::int AS total_arrets,
       COUNT(DISTINCT mc.match_id)::int AS total_matchs
       FROM core.match_compositions mc
       JOIN core.joueurs jj ON jj.id = mc.joueur_id
      WHERE jj.numero_licence = $1`,
    [numeroLicence],
  );
  const stats = statsRes.rows[0]!;

  // 3. Historique 10 derniers matchs
  const histRes = await query<Record<string, unknown>>(
    `SELECT m.id_ffhb_match, m.date_heure,
            ed.nom AS equipe_dom_nom, ee.nom AS equipe_ext_nom,
            m.score_dom, m.score_ext,
            ej.nom AS equipe_joueur_nom,
            mc.but_count AS buts, mc.tirs_count AS tirs, mc.arrets_count AS arrets
       FROM core.match_compositions mc
       JOIN core.joueurs jj ON jj.id = mc.joueur_id
       JOIN core.matchs m ON m.id = mc.match_id
       JOIN core.equipes ed ON ed.id = m.equipe_dom_id
       JOIN core.equipes ee ON ee.id = m.equipe_ext_id
       JOIN core.equipes ej ON ej.id = mc.equipe_id
      WHERE jj.numero_licence = $1
      ORDER BY m.date_heure DESC
      LIMIT 10`,
    [numeroLicence],
  );

  return {
    numero_licence: j.numero_licence as string,
    nom: j.nom as string,
    prenom: j.prenom as string,
    date_naissance: j.date_naissance ? String(j.date_naissance) : null,
    sexe: j.sexe as string | null,
    nationalite: j.nationalite as string | null,
    stats: {
      total_buts: stats.total_buts as number,
      total_exclusions_2min: stats.total_exclusions_2min as number,
      total_tirs: stats.total_tirs as number,
      total_arrets: stats.total_arrets as number,
      total_matchs: stats.total_matchs as number,
    },
    historique: histRes.rows.map((r) => ({
      id_ffhb_match: r.id_ffhb_match as string,
      date_heure: r.date_heure as Date,
      equipe_dom_nom: r.equipe_dom_nom as string,
      equipe_ext_nom: r.equipe_ext_nom as string,
      score_dom: r.score_dom as number | null,
      score_ext: r.score_ext as number | null,
      equipe_joueur_nom: r.equipe_joueur_nom as string,
      buts: r.buts as number,
      tirs: r.tirs as number,
      arrets: r.arrets as number,
    })),
  };
}

export interface JoueurMatchItem {
  id_ffhb_match: string;
  date_heure: Date;
  statut: string;
  equipe_nom: string;
  adversaire_nom: string;
  score_equipe: number | null;
  score_adversaire: number | null;
  buts: number;
  poule_id_ffhb: string;
  competition_nom: string;
}

/** Historique complet (paginé) des matchs d'un joueur, via match_compositions. null si joueur absent. */
export async function getJoueurMatchs(
  numeroLicence: string,
  limit: number,
  offset: number,
): Promise<{ data: JoueurMatchItem[]; total: number } | null> {
  const jRes = await query<{ id: bigint }>(
    `SELECT id FROM core.joueurs WHERE numero_licence = $1`,
    [numeroLicence],
  );
  if (jRes.rowCount === 0) return null;
  const joueurId = jRes.rows[0]!.id;

  const countRes = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM core.match_compositions mc WHERE mc.joueur_id = $1`,
    [joueurId],
  );
  const total = countRes.rows[0]!.total;

  const dataRes = await query<JoueurMatchItem>(
    `SELECT m.id_ffhb_match, m.date_heure, m.statut,
            ep.nom AS equipe_nom,
            CASE WHEN m.equipe_dom_id = mc.equipe_id THEN ee.nom ELSE ed.nom END AS adversaire_nom,
            CASE WHEN m.equipe_dom_id = mc.equipe_id THEN m.score_dom ELSE m.score_ext END AS score_equipe,
            CASE WHEN m.equipe_dom_id = mc.equipe_id THEN m.score_ext ELSE m.score_dom END AS score_adversaire,
            mc.but_count AS buts,
            po.id_ffhb AS poule_id_ffhb, c.nom AS competition_nom
       FROM core.match_compositions mc
       JOIN core.matchs m ON m.id = mc.match_id
       JOIN core.equipes ep ON ep.id = mc.equipe_id
       JOIN core.equipes ed ON ed.id = m.equipe_dom_id
       JOIN core.equipes ee ON ee.id = m.equipe_ext_id
       JOIN core.poules po ON po.id = m.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE mc.joueur_id = $1
      ORDER BY m.date_heure ASC
      LIMIT $2 OFFSET $3`,
    [joueurId, limit, offset],
  );
  return { data: dataRes.rows, total };
}
