// src/api/lib/repositories/match.repo.ts
import { query } from "@/db/client.js";

export interface MatchListItem {
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

export interface MatchDetail extends MatchListItem {
  equipe_dom_id_ffhb: string;
  equipe_ext_id_ffhb: string;
  score_mt_dom: number | null;
  score_mt_ext: number | null;
  heure_estimee: boolean;
  equipement_id: string | null;
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

export interface MatchListOptions {
  poule_id_ffhb?: string;
  date_from?: string;
  date_to?: string;
  statut?: string;
  limit: number;
  offset: number;
}

export async function listMatchs(opts: MatchListOptions): Promise<{ data: MatchListItem[]; total: number }> {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];

  if (opts.poule_id_ffhb) {
    params.push(opts.poule_id_ffhb);
    where.push(`po.id_ffhb = $${params.length}`);
  }
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
    `SELECT count(*)::int AS total
       FROM core.matchs m
       JOIN core.poules po ON po.id = m.poule_id
      WHERE ${whereClause}`,
    params,
  );
  const total = countRes.rows[0]!.total;

  params.push(opts.limit);
  params.push(opts.offset);
  const dataRes = await query<MatchListItem>(
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
      ORDER BY m.date_heure DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { data: dataRes.rows, total };
}

export async function getMatchDetail(idFfhbMatch: string): Promise<MatchDetail | null> {
  // Base
  const baseRes = await query<Record<string, unknown>>(
    `SELECT m.*, ed.id_ffhb AS equipe_dom_id_ffhb, ed.nom AS equipe_dom_nom,
            ee.id_ffhb AS equipe_ext_id_ffhb, ee.nom AS equipe_ext_nom,
            po.id_ffhb AS poule_id_ffhb, c.nom AS competition_nom
       FROM core.matchs m
       JOIN core.equipes ed ON ed.id = m.equipe_dom_id
       JOIN core.equipes ee ON ee.id = m.equipe_ext_id
       JOIN core.poules po ON po.id = m.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE m.id_ffhb_match = $1`,
    [idFfhbMatch],
  );
  if (baseRes.rowCount === 0) return null;
  const base = baseRes.rows[0]!;

  // Compositions
  const compoRes = await query<Record<string, unknown>>(
    `SELECT mc.*, j.numero_licence, j.nom AS joueur_nom, j.prenom AS joueur_prenom,
            CASE WHEN mc.equipe_id = $2 THEN 'dom' ELSE 'ext' END AS cote
       FROM core.match_compositions mc
       JOIN core.joueurs j ON j.id = mc.joueur_id
      WHERE mc.match_id = $1
      ORDER BY cote, mc.numero_maillot`,
    [base.id, base.equipe_dom_id],
  );

  // Actions
  const actRes = await query<Record<string, unknown>>(
    `SELECT * FROM core.match_actions WHERE match_id = $1 ORDER BY ordre`,
    [base.id],
  );

  // Officiels (arbitres)
  const offRes = await query<Record<string, unknown>>(
    `SELECT mo.role, a.nom AS arbitre_nom, a.prenom AS arbitre_prenom
       FROM core.match_officiels mo
       JOIN core.arbitres a ON a.id = mo.arbitre_id
      WHERE mo.match_id = $1
      ORDER BY mo.role`,
    [base.id],
  );

  return {
    id_ffhb_match: base.id_ffhb_match as string,
    date_heure: base.date_heure as Date,
    statut: base.statut as string,
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
