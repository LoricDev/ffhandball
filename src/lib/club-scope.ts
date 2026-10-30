// src/lib/club-scope.ts — périmètre d'un club pour les scrapes ciblés (--club) : ses équipes (ententes comprises)
// et les poules où elles sont engagées, d'après ce qui est déjà en base.
import { query } from "@/db/client.js";
import { resolveLinkedTeams } from "@/api/lib/repositories/club-matchs.repo.js";

export interface ClubScope {
  club: { id_ffhb: string; code_ffhb: string | null; nom: string; slug: string | null };
  /** Équipes du club et de ses ententes (core.equipes.id). */
  equipeIds: string[];
  /** Poules où ces équipes sont engagées (core.poules.id_ffhb). */
  pouleIds: string[];
}

/** `cle` : code FFHB à 7 chiffres ou id_ffhb (id_club monclub). */
export async function resolveClubScope(cle: string, saison: string): Promise<ClubScope> {
  const clubRes = await query<ClubScope["club"]>(
    `SELECT id_ffhb, code_ffhb, nom, slug FROM core.clubs WHERE id_ffhb = $1 OR code_ffhb = $1`,
    [cle],
  );
  const club = clubRes.rows[0];
  if (!club) {
    throw new Error(`club ${cle} introuvable en base : lancer d'abord scrape/etl clubs`);
  }
  const equipes = await resolveLinkedTeams(club, saison, true);
  const equipeIds = equipes.map((e) => String(e.id));
  if (equipeIds.length === 0) {
    throw new Error(`aucune équipe liée au club ${club.nom} (${cle}) pour ${saison} : scrape/etl matchs et équipes d'abord`);
  }
  const poules = await query<{ id_ffhb: string }>(
    `SELECT DISTINCT po.id_ffhb
       FROM core.engagements en
       JOIN core.poules po ON po.id = en.poule_id
      WHERE en.equipe_id = ANY($1::bigint[]) AND po.saison_code = $2`,
    [equipeIds, saison],
  );
  return { club, equipeIds, pouleIds: poules.rows.map((r) => r.id_ffhb) };
}
