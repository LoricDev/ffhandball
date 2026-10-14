// src/db/reap-orphans.ts — clôture les runs « fantômes » restés en 'running' (processus tué/crashé).
import { query } from "@/db/client.js";

export interface ReapResult {
  scrapes: number;
  etls: number;
}

/**
 * Scrape : 'running' sans activité (heartbeat last_activity_at) depuis plus de `scrapeIdleHours`.
 * ETL    : 'running' démarré depuis plus de `etlMaxHours` (un ETL normal dure quelques minutes).
 * `dryRun` : compte sans modifier.
 */
export async function reapOrphanRuns(opts: {
  scrapeIdleHours: number;
  etlMaxHours: number;
  dryRun?: boolean;
}): Promise<ReapResult> {
  const scrapeWhere = `status = 'running' AND COALESCE(last_activity_at, started_at) < now() - ($1::float * interval '1 hour')`;
  const etlWhere = `status = 'running' AND started_at < now() - ($1::float * interval '1 hour')`;

  if (opts.dryRun) {
    const s = await query<{ n: string }>(`SELECT count(*)::bigint AS n FROM raw.scrape_runs WHERE ${scrapeWhere}`, [opts.scrapeIdleHours]);
    const e = await query<{ n: string }>(`SELECT count(*)::bigint AS n FROM core.etl_runs WHERE ${etlWhere}`, [opts.etlMaxHours]);
    return { scrapes: Number(s.rows[0]!.n), etls: Number(e.rows[0]!.n) };
  }

  const s = await query(
    `UPDATE raw.scrape_runs
        SET status = 'failed', finished_at = now(),
            error_message = 'orphelin : aucun heartbeat depuis plus de ' || $1::text || ' h (processus interrompu)'
      WHERE ${scrapeWhere}`,
    [opts.scrapeIdleHours],
  );
  const e = await query(
    `UPDATE core.etl_runs
        SET status = 'failed', finished_at = now(),
            error_message = 'orphelin : en cours depuis plus de ' || $1::text || ' h (processus interrompu)'
      WHERE ${etlWhere}`,
    [opts.etlMaxHours],
  );
  return { scrapes: s.rowCount ?? 0, etls: e.rowCount ?? 0 };
}
