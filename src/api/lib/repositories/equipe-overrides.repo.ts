// src/api/lib/repositories/equipe-overrides.repo.ts — corrections manuelles du regroupement des équipes.
import { query } from "@/db/client.js";
import type { EquipeOverride } from "@/api/lib/equipe-groupes.js";

export interface EquipeOverrideRow extends EquipeOverride {
  equipe_id_ffhb: string;
  note: string | null;
  updated_at: Date;
}

const COLS = `equipe_id_ffhb, categorie, sexe, rang, entente, exclu, note, updated_at`;

/** Corrections applicables à ces inscriptions, indexées par id FFHB. */
export async function getOverrides(ids: string[]): Promise<Map<string, EquipeOverrideRow>> {
  if (ids.length === 0) return new Map();
  const r = await query<EquipeOverrideRow>(`SELECT ${COLS} FROM core.equipe_overrides WHERE equipe_id_ffhb = ANY($1::text[])`, [ids]);
  return new Map(r.rows.map((o) => [o.equipe_id_ffhb, o]));
}

export async function listOverrides(): Promise<EquipeOverrideRow[]> {
  const r = await query<EquipeOverrideRow>(`SELECT ${COLS} FROM core.equipe_overrides ORDER BY updated_at DESC`);
  return r.rows;
}

export interface OverrideInput {
  categorie?: string | null;
  sexe?: string | null;
  rang?: number | null;
  entente?: boolean | null;
  exclu?: boolean;
  note?: string | null;
}

/** Crée ou remplace la correction d'une inscription. Retourne null si l'inscription n'existe pas. */
export async function upsertOverride(id: string, o: OverrideInput): Promise<EquipeOverrideRow | null> {
  const exists = await query(`SELECT 1 FROM core.equipes WHERE id_ffhb = $1 LIMIT 1`, [id]);
  if (exists.rowCount === 0) return null;
  const r = await query<EquipeOverrideRow>(
    `INSERT INTO core.equipe_overrides (equipe_id_ffhb, categorie, sexe, rang, entente, exclu, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (equipe_id_ffhb) DO UPDATE
       SET categorie = EXCLUDED.categorie, sexe = EXCLUDED.sexe, rang = EXCLUDED.rang,
           entente = EXCLUDED.entente, exclu = EXCLUDED.exclu, note = EXCLUDED.note, updated_at = now()
     RETURNING ${COLS}`,
    [id, o.categorie ?? null, o.sexe ?? null, o.rang ?? null, o.entente ?? null, o.exclu ?? false, o.note ?? null],
  );
  return r.rows[0]!;
}

export async function deleteOverride(id: string): Promise<boolean> {
  const r = await query(`DELETE FROM core.equipe_overrides WHERE equipe_id_ffhb = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}
