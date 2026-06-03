// src/cli/diag.ts — diagnostic préflight du pipeline (à lancer avant un run, en cron ou en CI).
// Usage : pnpm diag [--strict] [--no-color]
// NB : pas nommé « doctor » — c'est une commande intégrée à npm ET pnpm (elle masquerait le script).
//
// Vérifie : base joignable, migrations à jour, variables d'environnement, source ffhandball.fr
// joignable, espace disque. Sort en 1 si une vérification CRITIQUE échoue (ou, avec --strict,
// si un simple avertissement est levé) — exploitable directement en cron/CI.
import { parseArgs } from "node:util";
import { statfs } from "node:fs/promises";
import { closePool, query } from "@/db/client.js";
import { env } from "@/config/env.js";
import { pendingMigrations } from "@/db/migrate.js";
import { initColor, col } from "@/lib/cli-color.js";
import { describeError } from "@/lib/describe-error.js";

type Level = "ok" | "warn" | "fail";
interface Check {
  label: string;
  level: Level;
  detail: string;
}

function icon(level: Level): string {
  if (level === "ok") return col.green("✓");
  if (level === "warn") return col.yellow("!");
  return col.red("✗");
}

function fmtBytes(b: number): string {
  const u = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

async function checkDb(): Promise<Check> {
  try {
    const r = await query<{ v: string }>(`SELECT version() AS v`);
    const v = r.rows[0]?.v?.split(" ").slice(0, 2).join(" ") ?? "ok";
    return { label: "Base de données", level: "ok", detail: v };
  } catch (err) {
    return { label: "Base de données", level: "fail", detail: describeError(err) };
  }
}

async function checkMigrations(): Promise<Check> {
  try {
    const pending = await pendingMigrations();
    if (pending.length === 0) return { label: "Migrations", level: "ok", detail: "à jour" };
    return {
      label: "Migrations",
      level: "warn",
      detail: `${pending.length} en attente (${pending[0]!.filename}…) → \`pnpm migrate up\` ` +
        `(ou \`baseline\` si la base est déjà à jour)`,
    };
  } catch (err) {
    return {
      label: "Migrations",
      level: "fail",
      detail: `vérification impossible (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

function checkEnv(): Check {
  const issues: string[] = [];
  if (env.SCRAPE_USER_AGENT.includes("TODO@example.com")) {
    issues.push("SCRAPE_USER_AGENT contient encore l'email TODO@example.com");
  }
  if (env.API_AUTH_ENABLED && !env.ADMIN_SECRET) {
    issues.push("API_AUTH_ENABLED=true mais ADMIN_SECRET absent (admin désactivé)");
  }
  if (!env.MAIL_HOST || !env.MAIL_TO) {
    issues.push("mail non configuré (MAIL_HOST/MAIL_TO) — notifications désactivées");
  }
  if (issues.length === 0) return { label: "Environnement", level: "ok", detail: "complet" };
  return { label: "Environnement", level: "warn", detail: issues.join(" ; ") };
}

async function checkSource(): Promise<Check> {
  const url = "https://www.ffhandball.fr/";
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": env.SCRAPE_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    // Toute réponse HTTP = source joignable (même 403/405 : c'est le réseau qu'on teste ici).
    return { label: "Source ffhandball.fr", level: "ok", detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      label: "Source ffhandball.fr",
      level: "warn",
      detail: `injoignable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

async function checkDisk(): Promise<Check> {
  try {
    const s = await statfs(process.cwd());
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    const pct = total > 0 ? (free / total) * 100 : 100;
    const detail = `${fmtBytes(free)} libres / ${fmtBytes(total)} (${pct.toFixed(0)}%)`;
    if (free < 2 * 1024 ** 3 || pct < 10) return { label: "Espace disque", level: "warn", detail };
    return { label: "Espace disque", level: "ok", detail };
  } catch (err) {
    return {
      label: "Espace disque",
      level: "warn",
      detail: `indéterminé (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

async function checkDbSize(): Promise<Check> {
  try {
    const r = await query<{ b: string }>(`SELECT pg_database_size(current_database())::bigint AS b`);
    return { label: "Taille base", level: "ok", detail: fmtBytes(Number(r.rows[0]!.b)) };
  } catch {
    return { label: "Taille base", level: "ok", detail: "-" };
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { strict: { type: "boolean" }, "no-color": { type: "boolean" } },
  });
  initColor(values["no-color"] === true ? false : undefined);

  const db = await checkDb();
  // Si la base est injoignable, inutile de tenter les checks qui en dépendent.
  const dbOk = db.level !== "fail";
  const checks: Check[] = [
    db,
    ...(dbOk ? [await checkMigrations()] : []),
    checkEnv(),
    await checkSource(),
    await checkDisk(),
    ...(dbOk ? [await checkDbSize()] : []),
  ];

  process.stdout.write("\n" + col.bold("ffhandball — diagnostic") + "\n");
  const labelW = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    process.stdout.write(`  ${icon(c.level)} ${c.label.padEnd(labelW)}  ${col.dim(c.detail)}\n`);
  }

  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  const verdict =
    fails > 0
      ? col.red(`✗ ${fails} échec(s)` + (warns ? `, ${warns} avert.` : ""))
      : warns > 0
        ? col.yellow(`! ${warns} avertissement(s)`)
        : col.green("✓ tout est au vert");
  process.stdout.write(`\n${verdict}\n`);

  if (fails > 0 || (values.strict === true && warns > 0)) process.exitCode = 1;
}

main()
  .catch((err) => {
    process.stderr.write(`${col.red("Erreur doctor")} : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
