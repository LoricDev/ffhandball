// src/cli/migrate.ts — applique/inspecte les migrations SQL via DATABASE_URL.
// Usage :
//   pnpm migrate            applique les migrations en attente (= `up`)
//   pnpm migrate up [--dry-run]
//   pnpm migrate status     liste appliquées / en attente / dérive de checksum
//   pnpm migrate baseline   marque toutes les migrations présentes comme appliquées
//                           (adoption d'une base déjà migrée par l'ancien db:migrate)
import { parseArgs } from "node:util";
import { closePool } from "@/db/client.js";
import {
  applyMigration,
  baseline,
  migrationStatuses,
  pendingMigrations,
} from "@/db/migrate.js";
import { initColor, col } from "@/lib/cli-color.js";
import { describeError } from "@/lib/describe-error.js";

async function cmdStatus(): Promise<void> {
  const st = await migrationStatuses();
  const applied = st.filter((s) => s.applied);
  const pending = st.filter((s) => !s.applied);
  const drift = st.filter((s) => s.drift);

  process.stdout.write(col.bold("Migrations\n"));
  for (const s of st) {
    const icon = s.applied ? col.green("✓") : col.yellow("·");
    const tag = s.drift
      ? col.red(" (dérive checksum !)")
      : s.applied
        ? col.dim(`  appliquée ${s.appliedAt?.toISOString().slice(0, 16).replace("T", " ")}`)
        : col.yellow("  en attente");
    process.stdout.write(`  ${icon} ${s.filename}${tag}\n`);
  }
  process.stdout.write(
    `\n${col.green(`${applied.length} appliquée(s)`)}  ${col.yellow(`${pending.length} en attente`)}` +
      (drift.length ? `  ${col.red(`${drift.length} en dérive`)}` : "") +
      "\n",
  );
  if (pending.length === 0 && applied.length === 0) {
    process.stdout.write(
      col.dim("Aucune migration enregistrée. Si la base est déjà à jour : `pnpm migrate baseline`.\n"),
    );
  }
}

async function cmdUp(dryRun: boolean): Promise<void> {
  const pending = await pendingMigrations();
  if (pending.length === 0) {
    process.stdout.write(col.green("✓ Base à jour — aucune migration en attente.\n"));
    return;
  }
  process.stdout.write(
    `${pending.length} migration(s) en attente${dryRun ? col.dim(" [DRY RUN]") : ""}\n`,
  );
  for (const f of pending) {
    if (dryRun) {
      process.stdout.write(`  ${col.yellow("·")} ${f.filename} ${col.dim("(non exécutée)")}\n`);
      continue;
    }
    const t0 = Date.now();
    try {
      await applyMigration(f);
    } catch (err) {
      process.stdout.write(`  ${col.red("✗")} ${f.filename}\n`);
      throw new Error(`Migration ${f.filename} échouée : ${err instanceof Error ? err.message : String(err)}`);
    }
    process.stdout.write(`  ${col.green("✓")} ${f.filename} ${col.dim(`(${Date.now() - t0}ms)`)}\n`);
  }
  if (!dryRun) process.stdout.write(col.green(`\n✓ ${pending.length} migration(s) appliquée(s).\n`));
}

async function cmdBaseline(): Promise<void> {
  const n = await baseline();
  process.stdout.write(
    n > 0
      ? col.green(`✓ ${n} migration(s) marquée(s) comme appliquée(s) (sans exécution).\n`)
      : col.dim("Rien à faire — toutes les migrations sont déjà enregistrées.\n"),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean" }, "no-color": { type: "boolean" } },
  });
  initColor(values["no-color"] === true ? false : undefined);
  const sub = positionals[0] ?? "up";
  const dryRun = values["dry-run"] === true;

  if (sub === "status") await cmdStatus();
  else if (sub === "up") await cmdUp(dryRun);
  else if (sub === "baseline") await cmdBaseline();
  else throw new Error(`Sous-commande inconnue : ${sub}. Utilise up | status | baseline.`);
}

main()
  .catch((err) => {
    process.stderr.write(`${col.red("Erreur migrate")} : ${describeError(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
