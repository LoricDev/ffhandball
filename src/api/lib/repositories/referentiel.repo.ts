// src/api/lib/repositories/referentiel.repo.ts
import { query } from "@/db/client.js";
import { toDayString } from "@/api/lib/dates.js";

export interface SaisonItem {
  saison_code: string;
  date_debut: string | null;
  date_fin: string | null;
}

export interface ReferentielItem {
  code: string;
  nom: string | null;
}

export async function listSaisons(): Promise<SaisonItem[]> {
  const r = await query<{ saison_code: string; date_debut: Date | null; date_fin: Date | null }>(
    `SELECT saison_code, date_debut, date_fin FROM core.saisons ORDER BY saison_code DESC`,
  );
  return r.rows.map((s) => ({
    saison_code: s.saison_code,
    date_debut: s.date_debut ? toDayString(s.date_debut) : null,
    date_fin: s.date_fin ? toDayString(s.date_fin) : null,
  }));
}

export async function listDepartements(): Promise<ReferentielItem[]> {
  const r = await query<ReferentielItem>(
    `SELECT code, nom FROM core.departements ORDER BY code`,
  );
  return r.rows;
}

export async function listLigues(): Promise<ReferentielItem[]> {
  const r = await query<ReferentielItem>(
    `SELECT code, nom FROM core.ligues ORDER BY nom`,
  );
  return r.rows;
}
