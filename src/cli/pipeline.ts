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

interface PipelineArgs {
  saison: string;
  from?: string;
  only?: string[];
  level?: "national" | "regional" | "departemental";
  dryRun: boolean;
  continueOnError: boolean;
}

function parseCliArgs(): PipelineArgs {
  const { values } = parseArgs({
    options: {
      saison: { type: "string" },
      from: { type: "string" },
      only: { type: "string" }, // entité(s) à exécuter, ex. --only=matchs,classements
      level: { type: "string" }, // transmis aux étapes scrape (national|regional|departemental)
      "dry-run": { type: "boolean" },
      "continue-on-error": { type: "boolean" }, // n'interrompt pas le run au 1er échec
    },
  });
  if (!values.saison) throw new Error("--saison requis");
  let level: PipelineArgs["level"];
  if (values.level !== undefined) {
    const valid = ["national", "regional", "departemental"] as const;
    if (!valid.includes(values.level as (typeof valid)[number])) {
      throw new Error(`--level invalide : ${values.level} (national|regional|departemental)`);
    }
    level = values.level as PipelineArgs["level"];
  }
  return {
    saison: canonicalizeSaison(values.saison),
    from: values.from,
    only: values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    level,
    dryRun: values["dry-run"] === true,
    continueOnError: values["continue-on-error"] === true,
  };
}

interface StepResult {
  label: string;
  status: "ok" | "fail";
  duration: string;
  error?: string;
}

function printRecap(results: StepResult[], startMs: number): void {
  if (results.length === 0) return;
  process.stdout.write("\n" + "─".repeat(50) + "\n");
  const w = Math.max(6, ...results.map((r) => r.label.length));
  for (const r of results) {
    const icon = r.status === "ok" ? "✓" : "✗";
    process.stdout.write(`  ${icon} ${r.label.padEnd(w)}  ${r.duration.padStart(7)}\n`);
  }
  const ok = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "fail").length;
  process.stdout.write(
    `  ${ok} ok${failed ? `, ${failed} échec(s)` : ""} · total ${fmtDur((Date.now() - startMs) / 1000)}\n`,
  );
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
  const { saison, from, only, level, dryRun, continueOnError } = parseCliArgs();

  // Sélection des étapes : --only (sous-ensemble par entité/libellé) prime sur --from (reprise).
  let steps = PIPELINE;
  if (only && only.length > 0) {
    steps = PIPELINE.filter((s) => only.some((o) => s.entity === o || s.label.includes(o)));
    if (steps.length === 0) {
      throw new Error(`--only="${only.join(",")}" ne correspond à aucune étape. Entités : ${[...new Set(PIPELINE.map((s) => s.entity))].join(", ")}`);
    }
  } else if (from) {
    const found = PIPELINE.findIndex((s) => s.label.includes(from) || s.entity === from);
    if (found === -1) {
      throw new Error(`--from="${from}" ne correspond à aucune étape. Étapes : ${PIPELINE.map((s) => s.label).join(", ")}`);
    }
    steps = PIPELINE.slice(found);
    process.stdout.write(`↩  Reprise à partir de : "${PIPELINE[found]!.label}"\n\n`);
  }

  const flags = [
    dryRun ? "[DRY RUN]" : null,
    continueOnError ? "[continue-on-error]" : null,
    level ? `[level=${level}]` : null,
  ].filter(Boolean).join(" ");
  process.stdout.write(`Pipeline saison ${saison} — ${steps.length} étapes${flags ? " " + flags : ""}\n`);
  process.stdout.write("─".repeat(50) + "\n");

  const total = steps.length;
  let current = 0;
  const completed: { label: string; duration: string }[] = [];
  const results: StepResult[] = [];
  const pipelineStart = Date.now();

  for (const step of steps) {
    current++;
    const prefix = `[${String(current).padStart(2, "0")}/${total}]`;
    const pct = Math.floor((current / total) * 100);
    const elapsed = fmtDur((Date.now() - pipelineStart) / 1000);
    // --level n'est transmis qu'aux étapes scrape (l'ETL ne filtre pas par niveau).
    const effectiveArgs = [...(step.extraArgs ?? [])];
    if (level && step.cmd === "scrape") effectiveArgs.push(`--level=${level}`);

    // Avancement global (étape courante + % + temps cumulé) ; la barre de chaque
    // sous-commande (scrape/etl) s'affiche en dessous via stdio "inherit".
    process.stdout.write(`\n${prefix} ${pct}% · cumul ${elapsed}  ${step.label}...\n`);

    if (dryRun) {
      process.stdout.write(`  → pnpm ${step.cmd} --entity=${step.entity} --saison=${saison}${effectiveArgs.length ? " " + effectiveArgs.join(" ") : ""}\n`);
      continue;
    }

    const start = Date.now();
    try {
      run(step.cmd, step.entity, saison, effectiveArgs);
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(`  ✓ done (${secs}s)\n`);
      completed.push({ label: step.label, duration: `${secs}s` });
      results.push({ label: step.label, status: "ok", duration: `${secs}s` });
    } catch (err) {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n✗ ${errMsg}\n`);
      results.push({ label: step.label, status: "fail", duration: `${secs}s`, error: errMsg });
      if (!continueOnError) {
        printRecap(results, pipelineStart);
        await sendPipelineFailure(saison, step.label, errMsg, completed);
        process.exit(1);
      }
      process.stdout.write(`  ${"↳ on continue (--continue-on-error)"}\n`);
    }
  }

  if (dryRun) {
    process.stdout.write("\n" + "─".repeat(50) + "\nDry run terminé.\n");
    return;
  }

  printRecap(results, pipelineStart);
  const failures = results.filter((r) => r.status === "fail");
  if (failures.length > 0) {
    await sendPipelineFailure(
      saison,
      failures.map((f) => f.label).join(", "),
      failures.map((f) => `${f.label} : ${f.error}`).join(" | "),
      completed,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`✓ Pipeline ${saison} terminé en ${fmtDur((Date.now() - pipelineStart) / 1000)} (${total} étapes).\n`);
    await sendPipelineSuccess(saison, completed);
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
