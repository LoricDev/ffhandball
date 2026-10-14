// src/api/lib/repositories/status.repo.ts — fraîcheur des données (endpoint public /status).
import { query } from "@/db/client.js";

/** Jeux de données exposés, avec le scraper qui les alimente et l'âge max avant « retard ». */
export const DATASETS = [
  { key: "matchs", label: "Matchs et résultats", scraper: "matchs", maxAgeHours: 36 },
  { key: "classements", label: "Classements", scraper: "classements", maxAgeHours: 36 },
  { key: "feuilles_match", label: "Feuilles de match", scraper: "feuilles-match", maxAgeHours: 36 },
  { key: "stats_joueurs", label: "Statistiques des joueurs", scraper: "stats-joueurs", maxAgeHours: 36 },
  { key: "competitions", label: "Compétitions, poules, équipes", scraper: "competitions", maxAgeHours: 9 * 24 },
  { key: "clubs", label: "Clubs et salles", scraper: "clubs", maxAgeHours: 9 * 24 },
] as const;

export type Etat = "ok" | "retard" | "inconnu";

export interface DatasetFreshness {
  key: string;
  label: string;
  derniere_maj: string | null;
  age_heures: number | null;
  etat: Etat;
}

export interface StatusReport {
  statut: "operationnel" | "degrade" | "panne";
  verifie_le: string;
  base_de_donnees: "connectee" | "indisponible";
  donnees: DatasetFreshness[];
}

/** Pur (testable) : état de chaque jeu de données + statut global, à partir des dernières réussites. */
export function buildStatus(
  lastSuccess: Map<string, Date | null>,
  dbOk: boolean,
  now: Date = new Date(),
): StatusReport {
  const donnees: DatasetFreshness[] = DATASETS.map((d) => {
    const at = lastSuccess.get(d.scraper) ?? null;
    if (!at) return { key: d.key, label: d.label, derniere_maj: null, age_heures: null, etat: "inconnu" as const };
    const age = (now.getTime() - at.getTime()) / 3_600_000;
    return {
      key: d.key,
      label: d.label,
      derniere_maj: at.toISOString(),
      age_heures: Math.round(age * 10) / 10,
      etat: age > d.maxAgeHours ? ("retard" as const) : ("ok" as const),
    };
  });
  const statut = !dbOk ? "panne" : donnees.some((d) => d.etat !== "ok") ? "degrade" : "operationnel";
  return { statut, verifie_le: now.toISOString(), base_de_donnees: dbOk ? "connectee" : "indisponible", donnees };
}

export async function getStatus(): Promise<StatusReport> {
  try {
    const res = await query<{ scraper_name: string; last_success: Date | null }>(
      `SELECT scraper_name, max(finished_at) FILTER (WHERE status = 'success') AS last_success
         FROM raw.scrape_runs
        WHERE scraper_name = ANY($1)
        GROUP BY scraper_name`,
      [DATASETS.map((d) => d.scraper)],
    );
    return buildStatus(new Map(res.rows.map((r) => [r.scraper_name, r.last_success])), true);
  } catch {
    return buildStatus(new Map(), false);
  }
}
