// src/api/lib/repositories/club-matchs.repo.ts
import { query } from "@/db/client.js";

export interface EquipeLiee {
  id: bigint;
  id_ffhb: string;
  nom: string;
  is_principal: boolean;
  is_entente: boolean;
}

export interface ClubMatchItem {
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
  club_recevant: boolean;
  via_entente: boolean;
  via_principal: boolean;
}

export interface ClubMatchsOptions {
  id_ffhb: string;
  saison: string;
  include_ententes: boolean;
  date_from?: string;
  date_to?: string;
  statut?: string;
  limit: number;
  offset: number;
}

export interface ClubMatchsResult {
  club: { id_ffhb: string; nom: string } | null;
  equipes_liees: EquipeLiee[];
  matchs: ClubMatchItem[];
  total: number;
}

export async function getClubMatchsCalendar(opts: ClubMatchsOptions): Promise<ClubMatchsResult> {
  // 1. Récupérer le club
  const clubRes = await query<{ id_ffhb: string; nom: string }>(
    `SELECT id_ffhb, nom FROM core.clubs WHERE id_ffhb = $1`,
    [opts.id_ffhb],
  );
  if (clubRes.rowCount === 0) {
    return { club: null, equipes_liees: [], matchs: [], total: 0 };
  }
  const club = clubRes.rows[0]!;

  // 2. Récupérer les équipes liées au club via matching textuel
  const equipesSql = `
    WITH club_info AS (
      SELECT nom FROM core.clubs WHERE id_ffhb = $1
    ),
    words_raw AS (
      SELECT lower(word) AS word
      FROM club_info, LATERAL regexp_split_to_table(nom, '\\s+') AS word
    ),
    keywords AS (
      SELECT DISTINCT word FROM words_raw WHERE length(word) >= 4
    )
    SELECT DISTINCT
      e.id,
      e.id_ffhb,
      e.nom,
      (e.nom = (SELECT nom FROM club_info)) AS is_principal,
      (e.nom ILIKE '%ENTENTE%' OR e.nom ILIKE 'ENT %' OR e.nom ILIKE '% ENT %') AS is_entente
    FROM core.equipes e
    WHERE e.saison_code = $2
      AND (
        -- Équipe principale : match exact
        e.nom = (SELECT nom FROM club_info)
        -- Équipes réserve : nom club + suffixe
        OR e.nom ILIKE (SELECT nom FROM club_info) || ' %'
        -- Ententes (uniquement si include_ententes = true)
        OR ($3 = true
            AND (e.nom ILIKE '%ENTENTE%' OR e.nom ILIKE 'ENT %' OR e.nom ILIKE '% ENT %')
            AND EXISTS (
              SELECT 1 FROM keywords kw
              WHERE lower(e.nom) LIKE '%' || kw.word || '%'
            ))
      )
    ORDER BY e.nom
  `;
  const equipesRes = await query<{
    id: bigint;
    id_ffhb: string;
    nom: string;
    is_principal: boolean;
    is_entente: boolean;
  }>(equipesSql, [opts.id_ffhb, opts.saison, opts.include_ententes]);

  const equipes_liees = equipesRes.rows;

  if (equipes_liees.length === 0) {
    return { club, equipes_liees: [], matchs: [], total: 0 };
  }

  // 3. Construire la liste des IDs d'équipes liées pour la requête matchs
  const equipeIds = equipes_liees.map((e) => e.id);
  // Créer un map id → équipe pour enrichir chaque match
  const equipeMap = new Map(equipes_liees.map((e) => [e.id.toString(), e]));

  // 4. Récupérer les matchs (avec filtres optionnels)
  const matchParams: unknown[] = [equipeIds];
  const matchWhere: string[] = ["(m.equipe_dom_id = ANY($1) OR m.equipe_ext_id = ANY($1))"];

  if (opts.date_from) {
    matchParams.push(opts.date_from);
    matchWhere.push(`m.date_heure >= $${matchParams.length}::timestamptz`);
  }
  if (opts.date_to) {
    matchParams.push(opts.date_to);
    matchWhere.push(`m.date_heure <= $${matchParams.length}::timestamptz`);
  }
  if (opts.statut) {
    matchParams.push(opts.statut);
    matchWhere.push(`m.statut = $${matchParams.length}`);
  }

  const whereClause = matchWhere.join(" AND ");

  // Count total
  const countRes = await query<{ total: number }>(
    `SELECT count(*)::int AS total
       FROM core.matchs m
       JOIN core.poules po ON po.id = m.poule_id
      WHERE ${whereClause}`,
    matchParams,
  );
  const total = countRes.rows[0]!.total;

  // Data (paginated)
  matchParams.push(opts.limit);
  matchParams.push(opts.offset);
  const dataRes = await query<{
    id_ffhb_match: string;
    date_heure: Date;
    statut: string;
    journee: number | null;
    equipe_dom_nom: string;
    equipe_ext_nom: string;
    equipe_dom_id: bigint;
    equipe_ext_id: bigint;
    score_dom: number | null;
    score_ext: number | null;
    poule_id_ffhb: string;
    competition_nom: string;
    fdm_url: string | null;
  }>(
    `SELECT m.id_ffhb_match, m.date_heure, m.statut, m.journee,
            ed.nom AS equipe_dom_nom, ee.nom AS equipe_ext_nom,
            m.equipe_dom_id, m.equipe_ext_id,
            m.score_dom, m.score_ext,
            po.id_ffhb AS poule_id_ffhb,
            c.nom AS competition_nom,
            m.fdm_url
       FROM core.matchs m
       JOIN core.equipes ed ON ed.id = m.equipe_dom_id
       JOIN core.equipes ee ON ee.id = m.equipe_ext_id
       JOIN core.poules po ON po.id = m.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE ${whereClause}
      ORDER BY m.date_heure ASC
      LIMIT $${matchParams.length - 1} OFFSET $${matchParams.length}`,
    matchParams,
  );

  // Enrichir chaque match avec club_recevant / via_entente / via_principal
  const matchs: ClubMatchItem[] = dataRes.rows.map((row) => {
    // Trouver quelle équipe liée est impliquée dans ce match
    // Priorité : équipe principale > réserve > entente (pour via_principal / via_entente)
    const domEquipe = equipeMap.get(row.equipe_dom_id.toString());
    const extEquipe = equipeMap.get(row.equipe_ext_id.toString());
    // L'équipe liée est celle qui est dans equipes_liees (dom ou ext)
    const matchedEquipe = domEquipe ?? extEquipe;

    return {
      id_ffhb_match: row.id_ffhb_match,
      date_heure: row.date_heure,
      statut: row.statut,
      journee: row.journee,
      equipe_dom_nom: row.equipe_dom_nom,
      equipe_ext_nom: row.equipe_ext_nom,
      score_dom: row.score_dom,
      score_ext: row.score_ext,
      poule_id_ffhb: row.poule_id_ffhb,
      competition_nom: row.competition_nom,
      fdm_url: row.fdm_url,
      club_recevant: !!domEquipe,
      via_entente: matchedEquipe?.is_entente ?? false,
      via_principal: matchedEquipe?.is_principal ?? false,
    };
  });

  return { club, equipes_liees, matchs, total };
}
