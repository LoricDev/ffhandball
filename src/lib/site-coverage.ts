// src/lib/site-coverage.ts — le site annonce-t-il des compétitions que nous ne lisons pas ?
//
// À chaque scrape des compétitions, le scraper journalise dans raw.site_sections les sections que
// ffhandball.fr annonce (available_types) et ce qu'il en a réellement lu. Ce module évalue ce journal :
// c'est le contrôle qui aurait détecté l'absence de la Coupe de France (section jamais visitée).
import { query } from "@/db/client.js";

export interface SiteSectionRow {
  section: string;
  announced: boolean;
  crawled: boolean;
  competitions: number;
  note: string | null;
}

export interface SiteCoverage {
  runStartedAt: Date;
  rows: SiteSectionRow[];
  /** Compétitions vues sur le site par ce scrape mais absentes de core.competitions (ETL en retard ou en échec). */
  missingInCore: number;
}

/** Âge max (jours) du dernier scrape des compétitions avant de déclarer la structure périmée. */
export const MAX_COVERAGE_AGE_DAYS = 3;

/** Pur (testable) : liste des problèmes à signaler pour cette couverture. */
export function evaluateSiteCoverage(cov: SiteCoverage, now: Date = new Date()): string[] {
  const problems: string[] = [];

  for (const r of cov.rows) {
    if (r.announced && !r.crawled) {
      problems.push(`Section « ${r.section} » annoncée par le site mais non lue (${r.note ?? "raison inconnue"})`);
    } else if (r.note?.startsWith("STRUCTURES")) {
      problems.push(`Section « ${r.section} » : ${r.note.replace(/^STRUCTURES\s*:\s*/, "")}`);
    }
  }

  if (cov.missingInCore > 0) {
    problems.push(
      `${cov.missingInCore} compétition(s) vue(s) sur le site mais absente(s) de la base (ETL des compétitions en retard ou en échec ?)`,
    );
  }

  const ageDays = (now.getTime() - cov.runStartedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_COVERAGE_AGE_DAYS) {
    problems.push(
      `La structure des compétitions n'a pas été relue depuis ${Math.floor(ageDays)} jours : poules, équipes et engagements (coupes, tirages) peuvent manquer`,
    );
  }
  return problems;
}

/** Dernier scrape des compétitions ayant journalisé ses sections ; null si aucun (avant la migration 0026). */
export async function loadSiteCoverage(saison: string): Promise<SiteCoverage | null> {
  const run = await query<{ id: string; started_at: Date }>(
    `SELECT r.id, r.started_at
       FROM raw.scrape_runs r
      WHERE r.scraper_name = 'competitions' AND r.saison = $1 AND r.status IN ('success', 'partial')
        AND EXISTS (SELECT 1 FROM raw.site_sections s WHERE s.scrape_run_id = r.id)
      ORDER BY r.started_at DESC
      LIMIT 1`,
    [saison],
  );
  const r = run.rows[0];
  if (!r) return null;

  const [sections, missing] = await Promise.all([
    query<SiteSectionRow>(
      `SELECT section, announced, crawled, competitions, note
         FROM raw.site_sections WHERE scrape_run_id = $1 ORDER BY section`,
      [r.id],
    ),
    query<{ n: number }>(
      `SELECT count(DISTINCT rc.natural_key)::int AS n
         FROM raw.competitions rc
        WHERE rc.scrape_run_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM core.competitions c WHERE c.id_ffhb = rc.natural_key AND c.saison_code = $2
          )`,
      [r.id, saison],
    ),
  ]);

  return { runStartedAt: r.started_at, rows: sections.rows, missingInCore: missing.rows[0]?.n ?? 0 };
}
