// src/cli/maintenance.ts — entretien DB : purge des logs API et des warnings ETL anciens + VACUUM ANALYZE.
// Usage : pnpm maintenance [--api-logs-days=90] [--etl-warnings-days=30] [--dry-run]
//         pnpm maintenance --reap-only [--dry-run]   (seulement clôturer les runs orphelins)
//
// core.api_logs grossit à chaque requête HTTP et core.etl_warnings à chaque ETL (des dizaines de
// milliers de lignes par run) : on purge les entrées plus vieilles que N jours, puis on lance
// VACUUM ANALYZE pour réutiliser l'espace et rafraîchir les stats du planner.
import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";
import { reapOrphanRuns } from "@/db/reap-orphans.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "api-logs-days": { type: "string" },
      "etl-warnings-days": { type: "string" },
      "dry-run": { type: "boolean" },
      "reap-only": { type: "boolean" },
      "scrape-idle-hours": { type: "string" },
      "etl-max-hours": { type: "string" },
    },
  });
  const days = Number(values["api-logs-days"] ?? 90);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--api-logs-days invalide : ${values["api-logs-days"]}`);
  const warnDays = Number(values["etl-warnings-days"] ?? 30);
  if (!Number.isFinite(warnDays) || warnDays <= 0) {
    throw new Error(`--etl-warnings-days invalide : ${values["etl-warnings-days"]}`);
  }
  const dryRun = values["dry-run"] === true;

  // 0. Runs fantômes (processus tué : statut resté running).
  const scrapeIdleHours = Number(values["scrape-idle-hours"] ?? 3);
  const etlMaxHours = Number(values["etl-max-hours"] ?? 6);
  if (!(scrapeIdleHours > 0) || !(etlMaxHours > 0)) throw new Error("--scrape-idle-hours / --etl-max-hours invalides");
  const reaped = await reapOrphanRuns({ scrapeIdleHours, etlMaxHours, dryRun });
  process.stdout.write(
    `runs orphelins ${dryRun ? "à clôturer" : "clôturés"} : ${reaped.scrapes} scrape(s) (> ${scrapeIdleHours} h sans activité), ${reaped.etls} ETL (> ${etlMaxHours} h)
`,
  );
  if (values["reap-only"]) return;

  // 1. Purge api_logs.
  const cnt = await query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM core.api_logs WHERE requested_at < now() - ($1::int * interval '1 day')`,
    [days],
  );
  const n = Number(cnt.rows[0]!.n);
  process.stdout.write(`api_logs à purger (> ${days} j) : ${n}\n`);
  if (n > 0 && !dryRun) {
    await query(`DELETE FROM core.api_logs WHERE requested_at < now() - ($1::int * interval '1 day')`, [days]);
    process.stdout.write(`  → ${n} ligne(s) supprimée(s)\n`);
  }

  // 2. Purge etl_warnings des runs ETL plus vieux que N jours (via l'index sur etl_run_id).
  const warnWhere = `etl_run_id IN (SELECT id FROM core.etl_runs WHERE started_at < now() - ($1::int * interval '1 day'))`;
  const wcnt = await query<{ n: string }>(`SELECT count(*)::bigint AS n FROM core.etl_warnings WHERE ${warnWhere}`, [warnDays]);
  const wn = Number(wcnt.rows[0]!.n);
  process.stdout.write(`etl_warnings à purger (runs > ${warnDays} j) : ${wn}\n`);
  if (wn > 0 && !dryRun) {
    await query(`DELETE FROM core.etl_warnings WHERE ${warnWhere}`, [warnDays]);
    process.stdout.write(`  → ${wn} ligne(s) supprimée(s)\n`);
  }

  // 3. VACUUM ANALYZE (hors transaction — pool.query simple).
  if (!dryRun) {
    process.stdout.write("VACUUM ANALYZE...\n");
    // PARALLEL 0 : le /dev/shm de 64 Mo du conteneur Docker est trop petit pour les workers parallèles.
    await query("VACUUM (ANALYZE, PARALLEL 0)");
    process.stdout.write("  → terminé\n");
  } else {
    process.stdout.write("(dry-run : VACUUM ANALYZE non exécuté)\n");
  }
}

main()
  .catch((err) => {
    process.stderr.write(`Erreur maintenance : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
