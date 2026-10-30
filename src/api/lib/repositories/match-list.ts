// src/api/lib/repositories/match-list.ts — requête de liste de matchs partagée (/matchs, /equipes/:id/matchs,
// /salles/:id/matchs, /poules/:id/matchs). Une seule requête renvoie la page ET le total (count(*) OVER()).
import { query } from "@/db/client.js";

export type MatchStatut = "a_jouer" | "joue" | "reporte" | "annule" | "forfait";

export interface MatchListRow {
  id_ffhb_match: string;
  date_heure: Date;
  statut: MatchStatut;
  forfait_equipe: "dom" | "ext" | null;
  journee: number | null;
  equipe_dom_id_ffhb: string;
  equipe_dom_nom: string;
  equipe_ext_id_ffhb: string;
  equipe_ext_nom: string;
  score_dom: number | null;
  score_ext: number | null;
  poule_id_ffhb: string;
  competition_nom: string;
  fdm_url: string | null;
  /** Fichier logo du club porteur de chaque équipe (null : entente sans club résolu, ou club sans logo). */
  logo_dom: string | null;
  logo_ext: string | null;
  phase_nom: string;
  poule_nom: string;
  /** Identifiant FFHB de l'équipement (salle) du match ; sans équivalent dans /salles (voir description du schéma). */
  equipement_id: string | null;
  /** Salle résolue (salle FFHB si rattachée, sinon équipement d'après les feuilles de match) ; accepté par /salles/{id}. */
  salle_id_ffhb: string | null;
  salle_nom: string | null;
  salle_ville: string | null;
  salle_adresse: string | null;
  /** true : salle déduite de la salle principale du club recevant (équipement inconnu), donc approximative. */
  salle_approx: boolean;
}

export interface MatchFilters {
  poule_id_ffhb?: string;
  competition_id_ffhb?: string;
  /** Équipe (domicile ou extérieur). Les ids d'équipe FFHB sont propres à une saison. */
  equipe_id_ffhb?: string;
  /** Équipes portées par ce club (core.equipes.ext_structure_id), domicile ou extérieur. */
  club_id_ffhb?: string;
  salle_id_ffhb?: string;
  journee?: number;
  date_from?: string;
  date_to?: string;
  statut?: MatchStatut;
  saison?: string;
}

export interface MatchPage {
  limit: number;
  offset: number;
  /** Défaut : date_desc. */
  tri?: "date_asc" | "date_desc";
}

/** Construit les conditions SQL (alias m/ed/ee/po/ph/c/s) et leurs paramètres. */
export function buildMatchWhere(f: MatchFilters, base: { where?: string[]; params?: unknown[] } = {}): {
  where: string[];
  params: unknown[];
} {
  const where = [...(base.where ?? [])];
  const params = [...(base.params ?? [])];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("$#", `$${params.length}`));
  };
  if (f.poule_id_ffhb) add("po.id_ffhb = $#", f.poule_id_ffhb);
  if (f.competition_id_ffhb) add("c.id_ffhb = $#", f.competition_id_ffhb);
  if (f.equipe_id_ffhb) add("(ed.id_ffhb = $# OR ee.id_ffhb = $#)", f.equipe_id_ffhb);
  if (f.club_id_ffhb) add("(ed.ext_structure_id = $# OR ee.ext_structure_id = $#)", f.club_id_ffhb);
  if (f.salle_id_ffhb) add("m.salle_id = (SELECT id FROM core.salles WHERE id_ffhb = $#)", f.salle_id_ffhb);
  if (f.journee !== undefined) add("m.journee = $#", f.journee);
  if (f.date_from) add("m.date_heure >= $#::timestamptz", f.date_from);
  if (f.date_to) add("m.date_heure <= $#::timestamptz", f.date_to);
  if (f.statut) add("m.statut = $#", f.statut);
  if (f.saison) add("po.saison_code = $#", f.saison);
  return { where, params };
}

const FROM = `
  FROM core.matchs m
  JOIN core.equipes ed ON ed.id = m.equipe_dom_id
  JOIN core.equipes ee ON ee.id = m.equipe_ext_id
  JOIN core.poules po ON po.id = m.poule_id
  JOIN core.phases ph ON ph.id = po.phase_id
  JOIN core.competitions c ON c.id = ph.competition_id
  LEFT JOIN core.clubs cd ON cd.id_ffhb = ed.ext_structure_id
  LEFT JOIN core.clubs ce ON ce.id_ffhb = ee.ext_structure_id
  LEFT JOIN core.salles sl ON sl.id = m.salle_id
  LEFT JOIN core.equipements eq ON eq.equipement_id = m.equipement_id
  LEFT JOIN core.clubs cp ON cp.id_ffhb = COALESCE(ed.ext_structure_id, ed.porteur_ext_structure_id)
  LEFT JOIN core.clubs cpe ON cpe.id_ffhb = COALESCE(ee.ext_structure_id, ee.porteur_ext_structure_id)
  LEFT JOIN core.salles cs ON cs.id = cp.salle_principale_id`;

/**
 * Page de matchs + total. Le tri est stabilisé par m.id (sinon des matchs de même heure
 * pouvaient apparaître sur deux pages, ou pas du tout).
 */
export async function queryMatchList(
  filters: MatchFilters,
  page: MatchPage,
  base: { where?: string[]; params?: unknown[] } = {},
): Promise<{ data: MatchListRow[]; total: number }> {
  const built = buildMatchWhere(filters, base);
  const { where, params } = built;
  const dir = page.tri === "date_asc" ? "ASC" : "DESC";
  const whereClause = where.length ? where.join(" AND ") : "TRUE";

  params.push(page.limit, page.offset);
  const res = await query<MatchListRow & { _total: number }>(
    `SELECT m.id_ffhb_match, m.date_heure, m.statut, m.forfait_equipe, m.journee,
            ed.id_ffhb AS equipe_dom_id_ffhb, ed.nom AS equipe_dom_nom,
            ee.id_ffhb AS equipe_ext_id_ffhb, ee.nom AS equipe_ext_nom,
            m.score_dom, m.score_ext, po.id_ffhb AS poule_id_ffhb,
            c.nom AS competition_nom, m.fdm_url,
            COALESCE(cd.logo_club, ed.logo, CASE WHEN ed.nom !~* '(entente|^ent | ent )' THEN cp.logo_club END) AS logo_dom,
            COALESCE(ce.logo_club, ee.logo, CASE WHEN ee.nom !~* '(entente|^ent | ent )' THEN cpe.logo_club END) AS logo_ext,
            ph.nom AS phase_nom, po.nom AS poule_nom, m.equipement_id,
            COALESCE(sl.id_ffhb, eq.equipement_id, cs.id_ffhb) AS salle_id_ffhb,
            COALESCE(sl.nom, eq.nom, cs.nom) AS salle_nom,
            COALESCE(sl.ville, eq.ville, cs.ville) AS salle_ville,
            COALESCE(sl.adresse, eq.adresse, cs.adresse) AS salle_adresse,
            (sl.id IS NULL AND eq.equipement_id IS NULL AND cs.id IS NOT NULL) AS salle_approx,
            count(*) OVER()::int AS _total
       ${FROM}
      WHERE ${whereClause}
      ORDER BY m.date_heure ${dir}, m.id ${dir}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const rows = res.rows;
  let total = rows[0]?._total ?? 0;
  if (rows.length === 0 && page.offset > 0) {
    // page au-delà de la fin : le total n'est pas porté par les lignes
    const countParams = params.slice(0, -2);
    const c = await query<{ total: number }>(
      `SELECT count(*)::int AS total ${FROM} WHERE ${whereClause}`,
      countParams,
    );
    total = c.rows[0]!.total;
  }
  return { data: rows.map(({ _total, ...r }) => r as MatchListRow), total };
}
