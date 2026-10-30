// src/api/lib/repositories/match.repo.ts
import { query } from "@/db/client.js";
import { queryMatchList, type MatchFilters, type MatchStatut } from "@/api/lib/repositories/match-list.js";

export type { MatchListRow as MatchListItem } from "@/api/lib/repositories/match-list.js";
import type { MatchListRow as MatchListItem } from "@/api/lib/repositories/match-list.js";

export interface MatchDetail extends MatchListItem {
  score_mt_dom: number | null;
  score_mt_ext: number | null;
  heure_estimee: boolean;
  compositions: Array<{
    cote: "dom" | "ext";
    joueur: { numero_licence: string; nom: string; prenom: string };
    numero_maillot: number | null;
    type_licence: string | null;
    capitaine: boolean;
    gardien: boolean;
    buts: number;
    tirs: number;
    arrets: number;
    sept_metres_reussis: number;
    avertissement: boolean;
    exclusions_2min: number;
    disqualifie: boolean;
  }>;
  actions: Array<{
    ordre: number;
    periode: number;
    temps_seconds: number;
    score_recevant: number;
    score_visiteur: number;
    type_action: string;
    cote: string | null;
    numero_maillot: number | null;
    description_brute: string | null;
  }>;
  officiels: Array<{
    role: string;
    arbitre_nom: string;
    arbitre_prenom: string | null;
  }>;
}

export interface MatchListOptions extends MatchFilters {
  tri?: "date_asc" | "date_desc";
  limit: number;
  offset: number;
}

export async function listMatchs(opts: MatchListOptions): Promise<{ data: MatchListItem[]; total: number }> {
  const { limit, offset, tri, ...filters } = opts;
  return queryMatchList(filters, { limit, offset, tri });
}

/** La poule existe-t-elle (pour distinguer « poule inconnue » de « poule sans match ») ? */
export async function pouleExists(pouleIdFfhb: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM core.poules WHERE id_ffhb = $1 LIMIT 1`, [pouleIdFfhb]);
  return (r.rowCount ?? 0) > 0;
}

export async function getMatchDetail(idFfhbMatch: string): Promise<MatchDetail | null> {
  // Base
  const baseRes = await query<Record<string, unknown>>(
    `SELECT m.*, ed.id_ffhb AS equipe_dom_id_ffhb, ed.nom AS equipe_dom_nom,
            ee.id_ffhb AS equipe_ext_id_ffhb, ee.nom AS equipe_ext_nom,
            po.id_ffhb AS poule_id_ffhb, c.nom AS competition_nom,
            COALESCE(cd.logo_club, ed.logo, CASE WHEN ed.nom !~* '(entente|^ent | ent )' THEN cp.logo_club END) AS logo_dom,
            COALESCE(ce.logo_club, ee.logo, CASE WHEN ee.nom !~* '(entente|^ent | ent )' THEN cpe.logo_club END) AS logo_ext,
            ph.nom AS phase_nom, po.nom AS poule_nom,
            COALESCE(sl.id_ffhb, eq.equipement_id, cs.id_ffhb) AS salle_id_ffhb,
            COALESCE(sl.nom, eq.nom, cs.nom) AS salle_nom,
            COALESCE(sl.ville, eq.ville, cs.ville) AS salle_ville,
            COALESCE(sl.adresse, eq.adresse, cs.adresse) AS salle_adresse,
            (sl.id IS NULL AND eq.equipement_id IS NULL AND cs.id IS NOT NULL) AS salle_approx
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
  LEFT JOIN core.salles cs ON cs.id = cp.salle_principale_id
      WHERE m.id_ffhb_match = $1`,
    [idFfhbMatch],
  );
  if (baseRes.rowCount === 0) return null;
  const base = baseRes.rows[0]!;

  // Compositions
  const [compoRes, actRes, offRes] = await Promise.all([
    query<Record<string, unknown>>(
    `SELECT mc.*, j.numero_licence, j.nom AS joueur_nom, j.prenom AS joueur_prenom,
            CASE WHEN mc.equipe_id = $2 THEN 'dom' ELSE 'ext' END AS cote
       FROM core.match_compositions mc
       JOIN core.joueurs j ON j.id = mc.joueur_id
      WHERE mc.match_id = $1
      ORDER BY cote, mc.numero_maillot`,
    [base.id, base.equipe_dom_id],
    ),

  // Actions
    query<Record<string, unknown>>(
    `SELECT * FROM core.match_actions WHERE match_id = $1 ORDER BY ordre`,
    [base.id],
    ),

  // Officiels (arbitres)
    query<Record<string, unknown>>(
    `SELECT mo.role, a.nom AS arbitre_nom, a.prenom AS arbitre_prenom
       FROM core.match_officiels mo
       JOIN core.arbitres a ON a.id = mo.arbitre_id
      WHERE mo.match_id = $1
      ORDER BY mo.role`,
    [base.id],
    ),
  ]);

  return {
    id_ffhb_match: base.id_ffhb_match as string,
    date_heure: base.date_heure as Date,
    statut: base.statut as MatchStatut,
    forfait_equipe: (base.forfait_equipe ?? null) as "dom" | "ext" | null,
    journee: base.journee as number | null,
    equipe_dom_nom: base.equipe_dom_nom as string,
    equipe_ext_nom: base.equipe_ext_nom as string,
    equipe_dom_id_ffhb: base.equipe_dom_id_ffhb as string,
    equipe_ext_id_ffhb: base.equipe_ext_id_ffhb as string,
    score_dom: base.score_dom as number | null,
    score_ext: base.score_ext as number | null,
    score_mt_dom: base.score_mt_dom as number | null,
    score_mt_ext: base.score_mt_ext as number | null,
    heure_estimee: base.heure_estimee as boolean,
    equipement_id: base.equipement_id as string | null,
    poule_id_ffhb: base.poule_id_ffhb as string,
    competition_nom: base.competition_nom as string,
    fdm_url: base.fdm_url as string | null,
    logo_dom: (base.logo_dom ?? null) as string | null,
    logo_ext: (base.logo_ext ?? null) as string | null,
    phase_nom: base.phase_nom as string,
    poule_nom: base.poule_nom as string,
    salle_id_ffhb: (base.salle_id_ffhb ?? null) as string | null,
    salle_nom: (base.salle_nom ?? null) as string | null,
    salle_ville: (base.salle_ville ?? null) as string | null,
    salle_adresse: (base.salle_adresse ?? null) as string | null,
    salle_approx: base.salle_approx === true,
    compositions: compoRes.rows.map((r) => ({
      cote: r.cote as "dom" | "ext",
      joueur: {
        numero_licence: r.numero_licence as string,
        nom: r.joueur_nom as string,
        prenom: r.joueur_prenom as string,
      },
      numero_maillot: r.numero_maillot as number | null,
      type_licence: r.type_licence as string | null,
      capitaine: r.capitaine as boolean,
      gardien: r.gardien as boolean,
      buts: r.but_count as number,
      tirs: r.tirs_count as number,
      arrets: r.arrets_count as number,
      sept_metres_reussis: r.sept_metres_reussis as number,
      avertissement: r.avertissement as boolean,
      exclusions_2min: r.exclusion_2min_count as number,
      disqualifie: r.disqualifie as boolean,
    })),
    actions: actRes.rows.map((r) => ({
      ordre: r.ordre as number,
      periode: r.periode as number,
      temps_seconds: r.temps_seconds as number,
      score_recevant: r.score_recevant as number,
      score_visiteur: r.score_visiteur as number,
      type_action: r.type_action as string,
      cote: r.cote as string | null,
      numero_maillot: r.numero_maillot as number | null,
      description_brute: r.description_brute as string | null,
    })),
    officiels: offRes.rows.map((r) => ({
      role: r.role as string,
      arbitre_nom: r.arbitre_nom as string,
      arbitre_prenom: r.arbitre_prenom as string | null,
    })),
  };
}
