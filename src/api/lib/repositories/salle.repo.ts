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

export async function getSalleByIdFfhb(idFfhb: string): Promise<SalleDetail | null> {
  const r = await query<SalleDetail>(
    `SELECT s.id_ffhb, s.nom, s.adresse, s.code_postal, s.ville,
            d.code AS departement_code, s.capacite
       FROM core.salles s
       LEFT JOIN core.departements d ON d.id = s.departement_id
      WHERE s.id_ffhb = $1`,
    [idFfhb],
  );
  if (r.rowCount === 0) return null;
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
  if (sRes.rowCount === 0) return null;
  const { limit, offset, tri, ...filters } = opts;
  return queryMatchList(
    filters,
    { limit, offset, tri: tri ?? "date_asc" },
    { where: ["m.salle_id = $1"], params: [sRes.rows[0]!.id] },
  );
}
