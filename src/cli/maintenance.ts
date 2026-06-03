// src/cli/maintenance.ts — entretien DB : purge des logs API anciens + VACUUM ANALYZE.
// Usage : pnpm maintenance [--api-logs-days=90] [--dry-run]
//
// core.api_logs grossit à chaque requête HTTP : on purge les entrées plus vieilles que N jours,
// puis on lance VACUUM ANALYZE pour récupérer l'espace et rafraîchir les stats du planner.
import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "api-logs-days": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  const days = Number(values["api-logs-days"] ?? 90);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--api-logs-days invalide : ${values["api-logs-days"]}`);
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

  // 2. VACUUM ANALYZE (hors transaction — pool.query simple).
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
