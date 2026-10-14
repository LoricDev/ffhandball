// src/cli/webhooks-deliver.ts — envoie les webhooks dus. Lancé chaque minute par cron (webhooks-deliver.sh).
//   pnpm webhooks:deliver [--limit=100]
import { parseArgs } from "node:util";
import { closePool } from "@/db/client.js";
import { deliverDue } from "@/webhooks/deliver.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { limit: { type: "string" } } });
  const limit = values.limit ? Number(values.limit) : 100;
  const r = await deliverDue({ limit });
  if (r.due > 0) {
    process.stdout.write(
      `webhooks : ${r.due} dus — ${r.delivered} livrés, ${r.retried} à réessayer, ${r.failed} abandonnés\n`,
    );
  }
}

main()
  .catch((err) => {
    process.stderr.write(`webhooks:deliver : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
