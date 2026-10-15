// src/lib/rattrapage-journees.ts — compteurs du dernier scrape matchs en mode « manquantes ».
// Lus par le récap quotidien (src/cli/monitor.ts) et le tableau de bord admin.
import { query } from "@/db/client.js";

export interface Rattrapage {
  started_at: Date;
  poules_concernees: number;
  journees_recuperees: number;
  journees_reportees: number;
  journees_en_echec: number;
  plafond: number;
}

/** Dernier scrape matchs « manquantes » terminé (null si aucun, ou plus vieux que `maxAgeHours`). */
export async function loadJourneesRattrapage(opts: { saison?: string; maxAgeHours?: number } = {}): Promise<Rattrapage | null> {
  const r = await query<{ started_at: Date; stats: Record<string, number> }>(
    `SELECT started_at, stats FROM raw.scrape_runs
      WHERE scraper_name = 'matchs' AND status IN ('success', 'partial')
        AND stats->>'mode' = 'manquantes'
        AND ($1::text IS NULL OR saison = $1)
        AND ($2::int IS NULL OR started_at > now() - make_interval(hours => $2))
      ORDER BY started_at DESC LIMIT 1`,
    [opts.saison ?? null, opts.maxAgeHours ?? null],
  );
  const row = r.rows[0];
  if (!row) return null;
  const s = row.stats;
  return {
    started_at: row.started_at,
    poules_concernees: Number(s.poules_concernees ?? 0),
    journees_recuperees: Number(s.journees_recuperees ?? 0),
    journees_reportees: Number(s.journees_reportees ?? 0),
    journees_en_echec: Number(s.journees_en_echec ?? 0),
    plafond: Number(s.plafond ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Base vs site : journées déjà commencées sur ffhandball.fr, et combien sont réellement en base.

/** Journées annoncées par le site pour une poule (lues sur sa page par défaut). Upsert par lot. */
export async function recordSiteJournees(
  saison: string,
  pouleIdFfhb: string,
  journees: Array<{ numero: number; date_debut: string | null; date_fin: string | null }>,
): Promise<void> {
  if (journees.length === 0) return;
  await query(
    `INSERT INTO raw.site_journees (saison, poule_id_ffhb, journee, date_debut, date_fin, seen_at)
     SELECT $1, $2, n, d1::date, d2::date, now()
       FROM unnest($3::int[], $4::text[], $5::text[]) AS t(n, d1, d2)
     ON CONFLICT (saison, poule_id_ffhb, journee)
     DO UPDATE SET date_debut = EXCLUDED.date_debut, date_fin = EXCLUDED.date_fin, seen_at = now()`,
    [saison, pouleIdFfhb, journees.map((j) => j.numero), journees.map((j) => j.date_debut), journees.map((j) => j.date_fin)],
  );
}

export interface CouvertureJournees {
  /** Journées déjà commencées sur le site (date de début ≤ aujourd'hui). */
  journees_site: number;
  /** Parmi elles, celles présentes en base et sans match resté « à jouer » alors que sa date est passée. */
  journees_en_base: number;
  poules_site: number;
  poules_incompletes: number;
  /** Dernière lecture d'une page de poule (fraîcheur de la connaissance du site). */
  derniere_lecture: Date | null;
  /** Compétitions les plus en retard. */
  top: Array<{ competition: string; manquantes: number }>;
}

const COUVERTURE_CTE = `
  WITH site AS (
    SELECT poule_id_ffhb, journee FROM raw.site_journees WHERE saison = $1 AND date_debut <= current_date
  ), complete AS (
    SELECT po.id_ffhb AS poule_id_ffhb, m.journee
      FROM core.matchs m
      JOIN core.poules po ON po.id = m.poule_id
      JOIN core.phases ph ON ph.id = po.phase_id
      JOIN core.competitions c ON c.id = ph.competition_id
     WHERE c.saison_code = $1 AND m.journee IS NOT NULL
     GROUP BY po.id_ffhb, m.journee
    HAVING NOT bool_or(m.statut = 'a_jouer' AND m.date_heure < now() - interval '6 hours')
  ), diff AS (
    SELECT s.poule_id_ffhb, s.journee, (c.journee IS NOT NULL) AS en_base
      FROM site s LEFT JOIN complete c USING (poule_id_ffhb, journee)
  )`;

/** null tant que le site n'a jamais été lu (avant le premier scrape des matchs qui suit la migration 0029). */
export async function loadCouvertureJournees(saison: string): Promise<CouvertureJournees | null> {
  const known = await query<{ n: number }>(`SELECT count(*)::int AS n FROM raw.site_journees WHERE saison = $1`, [saison]);
  if ((known.rows[0]?.n ?? 0) === 0) return null;

  const [tot, last, top] = await Promise.all([
    query<{ site: number; en_base: number; poules: number; incompletes: number }>(
      `${COUVERTURE_CTE}
       SELECT count(*)::int AS site, count(*) FILTER (WHERE en_base)::int AS en_base,
              count(DISTINCT poule_id_ffhb)::int AS poules,
              count(DISTINCT poule_id_ffhb) FILTER (WHERE NOT en_base)::int AS incompletes
         FROM diff`,
      [saison],
    ),
    query<{ t: Date | null }>(`SELECT max(seen_at) AS t FROM raw.site_journees WHERE saison = $1`, [saison]),
    query<{ competition: string; manquantes: number }>(
      `${COUVERTURE_CTE}
       SELECT c.nom AS competition, count(*)::int AS manquantes
         FROM diff d
         JOIN core.poules po ON po.id_ffhb = d.poule_id_ffhb
         JOIN core.phases ph ON ph.id = po.phase_id
         JOIN core.competitions c ON c.id = ph.competition_id AND c.saison_code = $1
        WHERE NOT d.en_base
        GROUP BY c.nom ORDER BY manquantes DESC, c.nom LIMIT 5`,
      [saison],
    ),
  ]);
  const t = tot.rows[0]!;
  return {
    journees_site: t.site,
    journees_en_base: t.en_base,
    poules_site: t.poules,
    poules_incompletes: t.incompletes,
    derniere_lecture: last.rows[0]?.t ?? null,
    top: top.rows,
  };
}
