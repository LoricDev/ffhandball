// src/api/lib/repositories/pipeline-status.repo.ts
// Instantané temps réel du pipeline (scrapes, ETL, trafic API, base) pour le tableau de bord admin.
import { query } from "@/db/client.js";

/** Tables raw dont le total sert de dénominateur pour la progression d'un ETL en streaming. */
const STREAMING_RAW: Record<string, string> = {
  matchs: "raw.matchs",
  classements: "raw.classements",
  stats_joueurs: "raw.stats_joueurs",
  feuilles_match: "raw.feuilles_match",
};

export async function getPipelineSnapshot() {
  const [scrapes, etls, traffic, errors, db, tables, lastByJob] = await Promise.all([
    query(
      `SELECT scraper_name, saison, status, started_at, finished_at, pages_scraped, pages_total, error_message
         FROM raw.scrape_runs ORDER BY started_at DESC LIMIT 40`,
    ),
    query(
      `SELECT id, entity, saison, status, started_at, finished_at, rows_read, rows_inserted, rows_updated,
              rows_rejected, warnings_count, error_message
         FROM core.etl_runs ORDER BY started_at DESC LIMIT 40`,
    ),
    query(
      `SELECT count(*)::int AS total_1h,
              count(*) FILTER (WHERE requested_at > now() - interval '5 minutes')::int AS total_5m,
              count(*) FILTER (WHERE status >= 500)::int AS err_5xx_1h,
              count(*) FILTER (WHERE status = 429)::int AS rate_limited_1h,
              count(*) FILTER (WHERE key_prefix IS NOT NULL)::int AS keyed_1h,
              COALESCE(round(avg(duration_ms)))::int AS avg_ms_1h,
              COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms_1h
         FROM core.api_logs
        WHERE requested_at > now() - interval '1 hour' AND path NOT LIKE '/admin%'`,
    ),
    query(
      `SELECT requested_at, method, path, status, duration_ms
         FROM core.api_logs
        WHERE status >= 500 AND requested_at > now() - interval '24 hours'
        ORDER BY requested_at DESC LIMIT 10`,
    ),
    query(`SELECT pg_database_size(current_database())::bigint AS bytes, now() AS db_time,
                  (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections`),
    query(
      `SELECT n.nspname AS schema, c.relname AS "table", c.reltuples::bigint AS rows,
              pg_total_relation_size(c.oid)::bigint AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname IN ('raw','core')
        ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`,
    ),
    query(
      `SELECT 'scrape' AS kind, scraper_name AS name, max(started_at) AS last_start,
              max(finished_at) FILTER (WHERE status = 'success') AS last_success
         FROM raw.scrape_runs GROUP BY scraper_name
       UNION ALL
       SELECT 'etl', entity, max(started_at), max(finished_at) FILTER (WHERE status = 'success')
         FROM core.etl_runs GROUP BY entity
       ORDER BY 1, 2`,
    ),
  ]);

  // Progression des ETL en cours (rows_read / lignes raw distinctes de la saison).
  const etlRows = await Promise.all(
    etls.rows.map(async (r) => {
      const table = STREAMING_RAW[String(r.entity).replace(/-/g, "_")];
      let rows_total: number | null = null;
      if (r.status === "running" && table && r.saison) {
        const t = await query<{ n: string }>(
          `SELECT count(DISTINCT natural_key)::bigint AS n FROM ${table} WHERE saison = $1`,
          [r.saison],
        );
        const n = Number(t.rows[0]?.n ?? 0);
        rows_total = n > 0 ? n : null;
      }
      return { ...r, rows_total };
    }),
  );

  return {
    generated_at: new Date().toISOString(),
    scrapes: scrapes.rows,
    etls: etlRows,
    last_by_job: lastByJob.rows,
    api: { ...traffic.rows[0], recent_errors: errors.rows },
    db: { ...db.rows[0], top_tables: tables.rows },
  };
}
