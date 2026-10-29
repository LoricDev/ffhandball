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

/** Contrôle d'intégrité de la base : une table clé vide ou une référence cassée rend l'API muette sans erreur. */
export interface IntegriteCheck {
  key: string;
  label: string;
  ok: boolean;
  /** `panne` : les réponses sont fausses ou vides ; `degrade` : une garde de la base manque. */
  gravite: "panne" | "degrade";
}

export interface StatusReport {
  statut: "operationnel" | "degrade" | "panne";
  verifie_le: string;
  base_de_donnees: "connectee" | "indisponible";
  donnees: DatasetFreshness[];
  integrite: IntegriteCheck[];
}

/** Pur (testable) : état de chaque jeu de données + statut global, à partir des dernières réussites. */
export function buildStatus(
  lastSuccess: Map<string, Date | null>,
  dbOk: boolean,
  now: Date = new Date(),
  integrite: IntegriteCheck[] = [],
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
  const ko = integrite.filter((c) => !c.ok);
  const statut = !dbOk || ko.some((c) => c.gravite === "panne")
    ? "panne"
    : ko.length > 0 || donnees.some((d) => d.etat !== "ok")
      ? "degrade"
      : "operationnel";
  return { statut, verifie_le: now.toISOString(), base_de_donnees: dbOk ? "connectee" : "indisponible", donnees, integrite };
}

/** Contrôles légers (EXISTS, pas de count) ; le résultat est mémorisé 60 s car /status est public. */
async function checkIntegrite(): Promise<IntegriteCheck[]> {
  const r = await query<Record<string, boolean>>(
    `SELECT EXISTS (SELECT 1 FROM core.matchs)  AS matchs,
            EXISTS (SELECT 1 FROM core.poules)  AS poules,
            EXISTS (SELECT 1 FROM core.equipes) AS equipes,
            EXISTS (SELECT 1 FROM core.clubs)   AS clubs,
            EXISTS (SELECT 1 FROM core.matchs m WHERE NOT EXISTS (SELECT 1 FROM core.poules p WHERE p.id = m.poule_id)) AS orphelins,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matchs_poule_id_fkey') AS fk_matchs`,
  );
  const x = r.rows[0]!;
  const plein = (key: string, label: string): IntegriteCheck => ({ key, label: `${label} présents`, ok: x[key]!, gravite: "panne" });
  return [
    plein("matchs", "Matchs"),
    plein("poules", "Poules"),
    plein("equipes", "Équipes"),
    plein("clubs", "Clubs"),
    { key: "matchs_sans_poule", label: "Tous les matchs rattachés à une poule", ok: !x.orphelins, gravite: "panne" },
    { key: "fk_matchs_poule", label: "Contrainte matchs → poules en place", ok: x.fk_matchs!, gravite: "degrade" },
  ];
}

let integriteCache: { at: number; value: IntegriteCheck[] } | null = null;

export async function getStatus(): Promise<StatusReport> {
  try {
    const res = await query<{ scraper_name: string; last_success: Date | null }>(
      `SELECT scraper_name, max(finished_at) FILTER (WHERE status = 'success') AS last_success
         FROM raw.scrape_runs
        WHERE scraper_name = ANY($1)
        GROUP BY scraper_name`,
      [DATASETS.map((d) => d.scraper)],
    );
    if (!integriteCache || Date.now() - integriteCache.at > 60_000) {
      integriteCache = { at: Date.now(), value: await checkIntegrite() };
    }
    return buildStatus(new Map(res.rows.map((r) => [r.scraper_name, r.last_success])), true, new Date(), integriteCache.value);
  } catch {
    return buildStatus(new Map(), false);
  }
}
