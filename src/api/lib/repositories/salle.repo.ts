// src/api/lib/repositories/salle.repo.ts
import { queryMatchList, type MatchListRow, type MatchStatut } from "@/api/lib/repositories/match-list.js";
import { query } from "@/db/client.js";

export interface SalleDetail {
  id_ffhb: string;
  nom: string;
  adresse: string | null;
  code_postal: string | null;
  ville: string | null;
  departement_code: string | null;
  capacite: number | null;
}

export type SalleMatchItem = MatchListRow;

/** Équipement (salle connue par les feuilles de match), clé = `equipement_id` des matchs. */
async function getEquipementById(id: string): Promise<SalleDetail | null> {
  const r = await query<SalleDetail>(
    `SELECT equipement_id AS id_ffhb, nom, adresse, code_postal, ville,
            NULL::text AS departement_code, NULL::int AS capacite
       FROM core.equipements WHERE equipement_id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

/** Salle par `id_ffhb` (slug des fiches clubs) ou, à défaut, par `equipement_id` d'un match. */
export async function getSalleByIdFfhb(idFfhb: string): Promise<SalleDetail | null> {
  const r = await query<SalleDetail>(
    `SELECT s.id_ffhb, s.nom, s.adresse, s.code_postal, s.ville,
            d.code AS departement_code, s.capacite
       FROM core.salles s
       LEFT JOIN core.departements d ON d.id = s.departement_id
      WHERE s.id_ffhb = $1`,
    [idFfhb],
  );
  if (r.rowCount === 0) return getEquipementById(idFfhb);
  return r.rows[0]!;
}

export interface SalleMatchsOptions {
  date_from?: string;
  date_to?: string;
  statut?: MatchStatut;
  journee?: number;
  tri?: "date_asc" | "date_desc";
  limit: number;
  offset: number;
}

export async function getSalleMatchs(
  idFfhb: string,
  opts: SalleMatchsOptions,
): Promise<{ data: SalleMatchItem[]; total: number } | null> {
  const sRes = await query<{ id: bigint }>(`SELECT id FROM core.salles WHERE id_ffhb = $1`, [idFfhb]);
  const parSalle = sRes.rowCount !== 0;
  if (!parSalle && !(await getEquipementById(idFfhb))) return null;
  const { limit, offset, tri, ...filters } = opts;
  return queryMatchList(
    filters,
    { limit, offset, tri: tri ?? "date_asc" },
    parSalle
      ? { where: ["m.salle_id = $1"], params: [sRes.rows[0]!.id] }
      : { where: ["m.equipement_id = $1"], params: [idFfhb] },
  );
}
