// src/cli/pipeline.ts — pipeline complet scrape + ETL pour une saison.
// Usage : npm run pipeline -- --saison=2025-2026 [--from=matchs] [--dry-run]
//
// --from=<étape>  : reprendre à partir d'une étape spécifique (skip les précédentes)
// --dry-run       : affiche les étapes sans les exécuter
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { sendPipelineSuccess, sendPipelineFailure } from "@/lib/mailer.js";

interface Step {
  label: string;
  cmd: "scrape" | "etl";
  entity: string;
  extraArgs?: string[];
}

const PIPELINE: Step[] = [
  // Clubs & salles
  { label: "scrape clubs",         cmd: "scrape", entity: "clubs" },
  { label: "scrape club-details",  cmd: "scrape", entity: "club-details" },
  { label: "etl salles",           cmd: "etl",    entity: "salles" },
  { label: "etl clubs",            cmd: "etl",    entity: "clubs" },

  // Structure des compétitions
  { label: "scrape competitions",  cmd: "scrape", entity: "competitions" },
  { label: "etl competitions",     cmd: "etl",    entity: "competitions" },
  { label: "etl phases",           cmd: "etl",    entity: "phases" },
  { label: "etl poules",           cmd: "etl",    entity: "poules" },
  { label: "etl equipes",          cmd: "etl",    entity: "equipes" },
  { label: "etl engagements",      cmd: "etl",    entity: "engagements" },

  // Matchs
  { label: "scrape matchs",        cmd: "scrape", entity: "matchs", extraArgs: ["--journees=all"] },
  { label: "etl matchs",           cmd: "etl",    entity: "matchs" },
  { label: "etl arbitres",         cmd: "etl",    entity: "arbitres" },
  { label: "etl match_officiels",  cmd: "etl",    entity: "match_officiels" },

  // Classements
  { label: "scrape classements",   cmd: "scrape", entity: "classements" },
  { label: "etl classements",      cmd: "etl",    entity: "classements" },

  // Stats joueurs
  { label: "scrape stats-joueurs", cmd: "scrape", entity: "stats-joueurs" },
  { label: "etl stats-joueurs",    cmd: "etl",    entity: "stats-joueurs" },

  // Feuilles de match
  { label: "scrape feuilles-match", cmd: "scrape", entity: "feuilles-match" },
  { label: "etl feuilles-match",    cmd: "etl",    entity: "feuilles-match" },
];

function parseCliArgs(): { saison: string; from?: string; dryRun: boolean } {
  const { values } = parseArgs({
    options: {
      saison:    { type: "string" },
      from:      { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  if (!values.saison) throw new Error("--saison requis");
  return {
    saison:  canonicalizeSaison(values.saison),
    from:    values.from,
    dryRun:  values["dry-run"] === true,
  };
}

function run(cmd: "scrape" | "etl", entity: string, saison: string, extraArgs: string[]): void {
  const args = ["run", cmd, "--", `--entity=${entity}`, `--saison=${saison}`, ...extraArgs];
  const result = spawnSync("npm", args, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    throw new Error(`Étape échouée : npm run ${cmd} -- --entity=${entity} (exit ${result.status ?? "signal"})`);
  }
}

async function main(): Promise<void> {
  const { saison, from, dryRun } = parseCliArgs();

  let steps = PIPELINE;
  if (from) {
    const idx = PIPELINE.findIndex((s) => s.entity === from && s.cmd === "scrape")
      ?? PIPELINE.findIndex((s) => s.label.includes(from));
    const found = PIPELINE.findIndex((s) => s.label.includes(from) || s.entity === from);
    if (found === -1) {
      throw new Error(`--from="${from}" ne correspond à aucune étape. Étapes : ${PIPELINE.map((s) => s.label).join(", ")}`);
    }
    steps = PIPELINE.slice(found);
    process.stdout.write(`↩  Reprise à partir de : "${PIPELINE[found]!.label}"\n\n`);
  }

  process.stdout.write(`Pipeline saison ${saison} — ${steps.length} étapes${dryRun ? " [DRY RUN]" : ""}\n`);
  process.stdout.write("─".repeat(50) + "\n");

  const total = steps.length;
  let current = 0;
  const completed: { label: string; duration: string }[] = [];

  for (const step of steps) {
    current++;
    const prefix = `[${String(current).padStart(2, "0")}/${total}]`;
    process.stdout.write(`\n${prefix} ${step.label}...\n`);

    if (dryRun) {
      process.stdout.write(`  → npm run ${step.cmd} -- --entity=${step.entity} --saison=${saison}${step.extraArgs ? " " + step.extraArgs.join(" ") : ""}\n`);
      continue;
    }

    const start = Date.now();
    try {
      run(step.cmd, step.entity, saison, step.extraArgs ?? []);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n✗ ${errMsg}\n`);
      await sendPipelineFailure(saison, step.label, errMsg, completed);
      process.exit(1);
    }
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`  ✓ done (${secs}s)\n`);
    completed.push({ label: step.label, duration: `${secs}s` });
  }

  process.stdout.write("\n" + "─".repeat(50) + "\n");
  if (dryRun) {
    process.stdout.write("Dry run terminé.\n");
  } else {
    process.stdout.write(`✓ Pipeline ${saison} terminé.\n`);
    await sendPipelineSuccess(saison, completed);
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
