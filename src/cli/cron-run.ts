// src/cli/cron-run.ts — suivi d'un cron en base (appelé par deploy/cron/lib-cron.sh).
//   pnpm cron-run start  <cron> [steps_total]      → affiche l'id du run
//   pnpm cron-run step   <id> <index> "<libellé>"
//   pnpm cron-run error  <id>
//   pnpm cron-run finish <id> <success|failed|skipped> ["message"]
// Ne doit JAMAIS faire échouer un cron : le shell l'appelle avec `|| true`.
import { closePool, query } from "@/db/client.js";

const STATUSES = new Set(["success", "failed", "skipped"]);

async function main(): Promise<void> {
  const [cmd, a, b, c] = process.argv.slice(2);
  switch (cmd) {
    case "start": {
      if (!a) throw new Error("usage: start <cron> [steps_total]");
      const total = Number.isFinite(Number(b)) ? Number(b) : 0;
      const r = await query<{ id: string }>(
        `INSERT INTO core.cron_runs (cron, steps_total) VALUES ($1, $2) RETURNING id`,
        [a, total],
      );
      process.stdout.write(`${r.rows[0]!.id}\n`);
      return;
    }
    case "step": {
      await query(
        `UPDATE core.cron_runs SET step_index = $2, current_step = $3, updated_at = now() WHERE id = $1`,
        [a, Number(b), c ?? null],
      );
      return;
    }
    case "error": {
      await query(`UPDATE core.cron_runs SET errors = errors + 1, updated_at = now() WHERE id = $1`, [a]);
      return;
    }
    case "finish": {
      if (!b || !STATUSES.has(b)) throw new Error("usage: finish <id> <success|failed|skipped> [message]");
      await query(
        `UPDATE core.cron_runs
            SET status = $2, finished_at = now(), updated_at = now(), current_step = NULL,
                error_message = $3
          WHERE id = $1 AND status = 'running'`,
        [a, b, c ?? null],
      );
      return;
    }
    default:
      throw new Error("commande inconnue (start|step|error|finish)");
  }
}

main()
  .catch((err) => {
    process.stderr.write(`cron-run : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
