// src/api/lib/repositories/club-matchs.repo.ts
import { query } from "@/db/client.js";
import {
  extractDistinctiveTokens,
  buildWholeWordPattern,
  rankToConfidence,
  RANK_BY_CONFIDENCE,
  LICENCE_MATCH_MIN_PLAYERS,
  type MatchMethod,
  type Confidence,
} from "@/api/lib/club-matching.js";

export interface EquipeLiee {
  id: bigint;
  id_ffhb: string;
  nom: string;
  is_principal: boolean;
  is_entente: boolean;
  match_method: MatchMethod;
  confidence: Confidence;
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
  confidence: Confidence;
}

export interface ClubMatchsOptions {
  id_ffhb: string;
  saison: string;
  include_ententes: boolean;
  date_from?: string;
  date_to?: string;
  statut?: string;
  min_confidence?: Confidence;
  limit: number;
  offset: number;
}

export interface ClubMatchsResult {
  club: { id_ffhb: string; code_ffhb: string | null; nom: string } | null;
  equipes_liees: EquipeLiee[];
  matchs: ClubMatchItem[];
  total: number;
}

export async function getClubMatchsCalendar(opts: ClubMatchsOptions): Promise<ClubMatchsResult> {
  // 1. Récupérer le club. Résolution par id_ffhb (= id_club monclub) OU par code_ffhb
  //    (code FFHB 7 chiffres public). code_ffhb sert aussi de clé à la couche "licence".
  const clubRes = await query<{ id_ffhb: string; code_ffhb: string | null; nom: string }>(
    `SELECT id_ffhb, code_ffhb, nom FROM core.clubs WHERE id_ffhb = $1 OR code_ffhb = $1`,
    [opts.id_ffhb],
  );
  if (clubRes.rowCount === 0) {
    return { club: null, equipes_liees: [], matchs: [], total: 0 };
  }
  const club = clubRes.rows[0]!;

  // 2. Résolution multi-signal des équipes liées (licence + structure + textuel)
  const equipes_liees = await resolveLinkedTeams(
    club,
    opts.saison,
    opts.include_ententes,
    opts.min_confidence,
  );

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
      confidence: matchedEquipe?.confidence ?? "basse",
    };
  });

  return { club, equipes_liees, matchs, total };
}

/**
 * Résout les équipes liées à un club via une union de 5 signaux, dédupliquées par équipe
 * en gardant la confiance maximale :
 *  - licence   (haute)   : ≥ LICENCE_MATCH_MIN_PLAYERS licenciés du club ont joué pour l'équipe
 *                          (clé = code FFHB 7 chiffres = préfixe licence = split_part(email,'@',1))
 *  - structure (haute)   : equipes.ext_structure_id = club.id_ffhb (= id_club monclub)
 *  - nom_exact (haute)   : e.nom = club.nom
 *  - nom_reserve (moy.)  : e.nom ILIKE club.nom || ' %'
 *  - nom_entente (basse) : entente partageant un token distinctif (mot entier) avec le club
 *
 * Deux espaces d'ID distincts coexistent côté FFHB :
 *  - `club.id_ffhb` = id_club monclub (= ext_structure_id des équipes) → couche `structure`.
 *  - `club.code_ffhb` = code FFHB 7 chiffres (colonne générée depuis l'email, = préfixe des
 *    numéros de licence) → couche `licence`. null si inconnu → couche licence inerte.
 */
async function resolveLinkedTeams(
  club: { id_ffhb: string; code_ffhb: string | null; nom: string },
  saison: string,
  include_ententes: boolean,
  min_confidence?: Confidence,
): Promise<EquipeLiee[]> {
  const pattern = buildWholeWordPattern(extractDistinctiveTokens(club.nom)); // string | null
  const minRank = min_confidence ? RANK_BY_CONFIDENCE[min_confidence] : null;
  const code7 = club.code_ffhb; // clé licence (null-safe : si null, couche licence inerte)

  const sql = `
    WITH comp AS (
      SELECT mc.equipe_id,
             count(DISTINCT j.id) FILTER (WHERE left(j.numero_licence, 7) = $1) AS n_club_players,
             count(DISTINCT left(j.numero_licence, 7)) AS n_distinct_clubs
        FROM core.match_compositions mc
        JOIN core.joueurs j ON j.id = mc.joueur_id
       WHERE mc.equipe_id IN (
         SELECT mc2.equipe_id
           FROM core.match_compositions mc2
           JOIN core.joueurs j2 ON j2.id = mc2.joueur_id
          WHERE left(j2.numero_licence, 7) = $1
       )
       GROUP BY mc.equipe_id
    ),
    signals AS (
      SELECT e.id, 'licence'::text AS method, 3 AS conf_rank
        FROM core.equipes e JOIN comp ON comp.equipe_id = e.id
       WHERE e.saison_code = $2 AND comp.n_club_players >= $3
      UNION ALL
      SELECT e.id, 'structure', 3
        FROM core.equipes e
       WHERE e.saison_code = $2 AND e.ext_structure_id = $8
      UNION ALL
      SELECT e.id, 'nom_exact', 3
        FROM core.equipes e
       WHERE e.saison_code = $2 AND e.nom = $4
      UNION ALL
      SELECT e.id, 'nom_reserve', 2
        FROM core.equipes e
       WHERE e.saison_code = $2 AND e.nom ILIKE $4 || ' %'
      UNION ALL
      SELECT e.id, 'nom_entente', 1
        FROM core.equipes e
       WHERE e.saison_code = $2
         AND $5::text IS NOT NULL
         AND e.nom ~* $5
         AND (e.nom ILIKE '%ENTENTE%' OR e.nom ILIKE 'ENT %' OR e.nom ILIKE '% ENT %')
    ),
    agg AS (
      SELECT e.id, e.id_ffhb, e.nom,
             max(s.conf_rank) AS conf_rank,
             (array_agg(s.method ORDER BY s.conf_rank DESC,
                CASE s.method
                  WHEN 'licence' THEN 1 WHEN 'structure' THEN 2 WHEN 'nom_exact' THEN 3
                  WHEN 'nom_reserve' THEN 4 ELSE 5 END))[1] AS match_method,
             bool_or(s.method = 'nom_exact') AS is_principal,
             (bool_or(e.nom ILIKE '%ENTENTE%' OR e.nom ILIKE 'ENT %' OR e.nom ILIKE '% ENT %')
               OR COALESCE(max(comp.n_distinct_clubs), 0) >= 2) AS is_entente
        FROM signals s
        JOIN core.equipes e ON e.id = s.id
        LEFT JOIN comp ON comp.equipe_id = e.id
       GROUP BY e.id, e.id_ffhb, e.nom
    )
    SELECT id, id_ffhb, nom, conf_rank, match_method, is_principal, is_entente
      FROM agg
     WHERE ($6 = true OR is_entente = false)
       AND ($7::int IS NULL OR conf_rank >= $7)
     ORDER BY nom
  `;

  const res = await query<{
    id: bigint;
    id_ffhb: string;
    nom: string;
    conf_rank: number;
    match_method: MatchMethod;
    is_principal: boolean;
    is_entente: boolean;
  }>(sql, [
    code7, // $1 — clé licence (code FFHB 7 chiffres, null-safe : si null, couche licence inerte)
    saison, // $2
    LICENCE_MATCH_MIN_PLAYERS, // $3
    club.nom, // $4
    pattern, // $5
    include_ententes, // $6
    minRank, // $7
    club.id_ffhb, // $8 — clé structure (= id_club monclub = ext_structure_id)
  ]);

  return res.rows.map((r) => ({
    id: r.id,
    id_ffhb: r.id_ffhb,
    nom: r.nom,
    is_principal: r.is_principal,
    is_entente: r.is_entente,
    match_method: r.match_method,
    confidence: rankToConfidence(r.conf_rank),
  }));
}
