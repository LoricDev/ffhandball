// src/cli/pipeline.ts — pipeline complet scrape + ETL pour une saison.
// Usage : pnpm pipeline --saison=2025-2026 [--from=matchs] [--dry-run]
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

  // Matchs — run régulier = incrémental (journées récemment jouées seulement, ~×20 moins de
  // requêtes que `all` → on ne fait plus basculer le WAF CloudFront/origine). Le backfill
  // complet d'une saison se fait UNE fois à la main : `scrape --entity=matchs --journees=all`.
  { label: "scrape matchs",        cmd: "scrape", entity: "matchs", extraArgs: ["--journees=recent"] },
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
  // pnpm transmet directement les args qui suivent le nom du script (pas de `--` nécessaire).
  const args = ["run", cmd, `--entity=${entity}`, `--saison=${saison}`, ...extraArgs];
  const result = spawnSync("pnpm", args, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    throw new Error(`Étape échouée : pnpm ${cmd} --entity=${entity} (exit ${result.status ?? "signal"})`);
  }
}

function fmtDur(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
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
  const pipelineStart = Date.now();

  for (const step of steps) {
    current++;
    const prefix = `[${String(current).padStart(2, "0")}/${total}]`;
    const pct = Math.floor((current / total) * 100);
    const elapsed = fmtDur((Date.now() - pipelineStart) / 1000);
    // Avancement global (étape courante + % + temps cumulé) ; la barre de chaque
    // sous-commande (scrape/etl) s'affiche en dessous via stdio "inherit".
    process.stdout.write(`\n${prefix} ${pct}% · cumul ${elapsed}  ${step.label}...\n`);

    if (dryRun) {
      process.stdout.write(`  → pnpm ${step.cmd} --entity=${step.entity} --saison=${saison}${step.extraArgs ? " " + step.extraArgs.join(" ") : ""}\n`);
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
    process.stdout.write(`✓ Pipeline ${saison} terminé en ${fmtDur((Date.now() - pipelineStart) / 1000)} (${total} étapes).\n`);
    await sendPipelineSuccess(saison, completed);
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
