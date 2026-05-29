// src/api/lib/repositories/referentiel.repo.ts
import { query } from "@/db/client.js";

export interface SaisonItem {
  saison_code: string;
  date_debut: string | Date | null;
  date_fin: string | Date | null;
}

export interface ReferentielItem {
  code: string;
  nom: string | null;
}

export async function listSaisons(): Promise<SaisonItem[]> {
  const r = await query<SaisonItem>(
    `SELECT saison_code, date_debut, date_fin FROM core.saisons ORDER BY saison_code DESC`,
  );
  return r.rows;
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
