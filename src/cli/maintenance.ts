// src/cli/maintenance.ts — entretien DB : purge des logs API et des warnings ETL anciens + VACUUM ANALYZE.
// Usage : pnpm maintenance [--api-logs-days=90] [--etl-warnings-days=30] [--dry-run]
//
// core.api_logs grossit à chaque requête HTTP et core.etl_warnings à chaque ETL (des dizaines de
// milliers de lignes par run) : on purge les entrées plus vieilles que N jours, puis on lance
// VACUUM ANALYZE pour réutiliser l'espace et rafraîchir les stats du planner.
import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "api-logs-days": { type: "string" },
      "etl-warnings-days": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const days = Number(values["api-logs-days"] ?? 90);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--api-logs-days invalide : ${values["api-logs-days"]}`);
  const warnDays = Number(values["etl-warnings-days"] ?? 30);
  if (!Number.isFinite(warnDays) || warnDays <= 0) {
    throw new Error(`--etl-warnings-days invalide : ${values["etl-warnings-days"]}`);
  }
  const dryRun = values["dry-run"] === true;

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
    await query("VACUUM ANALYZE");
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
