// src/api/lib/repositories/equipe.repo.ts
import { queryMatchList, type MatchListRow, type MatchStatut } from "@/api/lib/repositories/match-list.js";
import { query } from "@/db/client.js";
import { resolveLinkedTeams } from "@/api/lib/repositories/club-matchs.repo.js";
import { RANK_BY_CONFIDENCE, type Confidence, type MatchMethod } from "@/api/lib/club-matching.js";
import { heriterLiens } from "@/api/lib/equipe-groupes.js";
import { getOverrides } from "@/api/lib/repositories/equipe-overrides.repo.js";

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

export type EquipeMatchItem = MatchListRow;

export interface ClubEquipe {
  id_ffhb: string;
  nom: string;
  engagements: EngagementRef[];
  /** Fichier logo de l'équipe côté FFHB (utile quand le club n'a pas de logo dans le CMS), null si aucun. */
  logo_club: string | null;
  /** Comment l'équipe a été rattachée au club (absent pour la liste « équipes propres » historique). */
  lien?: { methode: MatchMethod | "groupe"; confiance: Confidence };
}

async function logosByEquipeIds(equipeIds: bigint[]): Promise<Map<string, string>> {
  if (equipeIds.length === 0) return new Map();
  const res = await query<{ id: bigint; logo: string }>(
    `SELECT id, logo FROM core.equipes WHERE id = ANY($1) AND logo IS NOT NULL`,
    [equipeIds],
  );
  return new Map(res.rows.map((r) => [r.id.toString(), r.logo]));
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
  statut?: MatchStatut;
  journee?: number;
  tri?: "date_asc" | "date_desc";
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
  const { limit, offset, tri, ...filters } = opts;
  return queryMatchList(
    filters,
    { limit, offset, tri: tri ?? "date_asc" },
    { where: ["(m.equipe_dom_id = $1 OR m.equipe_ext_id = $1)"], params: [eqRes.rows[0]!.id] },
  );
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

/**
 * Équipes d'un club : celles dont il est le porteur (pont autoritatif ext_structure_id = clubs.id_ffhb)
 * ET les ententes / conventions où il est seulement partenaire. Chez FFHB une entente est rattachée au
 * club « porteur » : « ENTENTE BOULAY/BOUZONVILLE SM » appartient à Boulay, donc sans cette résolution
 * elle manquait dans la liste de Bouzonville. Même résolution multi-signal que /clubs/:id/matchs
 * (licences des joueurs, structure, nom) ; chaque équipe porte le signal et la confiance qui l'ont rattachée.
 */
export async function listClubEquipesAvecPartenaires(
  club: { id_ffhb: string; code_ffhb: string | null; nom: string },
  saison: string,
  opts: { include_ententes: boolean; min_confidence?: Confidence },
): Promise<ClubEquipe[]> {
  // Pas de filtre de confiance ici : l'héritage de lien (heriterLiens) doit voir les « basse » avant qu'on les écarte.
  const linked = await resolveLinkedTeams(club, saison, opts.include_ententes);
  const engMap = await engagementsByEquipeIds(linked.map((l) => l.id));
  const logos = await logosByEquipeIds(linked.map((l) => l.id));
  const equipes: ClubEquipe[] = linked.map((l) => ({
    id_ffhb: l.id_ffhb,
    nom: l.nom,
    engagements: engMap.get(l.id.toString()) ?? [],
    logo_club: logos.get(l.id.toString()) ?? null,
    lien: { methode: l.match_method, confiance: l.confidence },
  }));
  const avecLiens = heriterLiens(equipes, await getOverrides(equipes.map((e) => e.id_ffhb)));
  if (!opts.min_confidence) return avecLiens;
  const minRank = RANK_BY_CONFIDENCE[opts.min_confidence];
  return avecLiens.filter((e) => RANK_BY_CONFIDENCE[e.lien!.confiance] >= minRank);
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
  const logos = await logosByEquipeIds(ids);
  return eqRes.rows.map((r) => ({
    id_ffhb: r.id_ffhb,
    nom: r.nom,
    engagements: engMap.get(r.id.toString()) ?? [],
    logo_club: logos.get(r.id.toString()) ?? null,
  }));
}
