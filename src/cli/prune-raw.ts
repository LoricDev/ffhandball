// src/cli/prune-raw.ts — rétention du schéma raw (append-only) pour contenir sa croissance.
// Usage :
//   pnpm prune-raw [--keep=3] [--saison=2025-2026] [--table=matchs] [--apply]
//   pnpm prune-raw --older-than-days=120 [--apply]
//
// Par défaut : DRY-RUN (montre ce qui serait purgé). Ajouter --apply pour supprimer réellement.
//  --keep=N            ne garde que les N captures les plus récentes par natural_key (défaut 3).
//  --older-than-days=D supprime les captures > D jours, en gardant TOUJOURS la plus récente.
//  --saison            restreint à une saison (sinon toutes).
//  --table             une seule table raw (sinon toutes les tables de capture).
import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { initColor, col } from "@/lib/cli-color.js";
import { describeError } from "@/lib/describe-error.js";

// Tables de capture raw (toutes : id PK, natural_key, scraped_at, saison). scrape_runs exclue.
const RAW_TABLES = [
  "clubs", "equipes", "joueurs", "competitions", "matchs",
  "feuilles_match", "classements", "arbitres", "salles",
] as const;

function num(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

interface Plan {
  table: string;
  total: number;
  toDelete: number;
  deleted: number | null; // null en dry-run
}

async function countTotal(table: string, saison: string | undefined): Promise<number> {
  const where = saison ? "WHERE saison = $1" : "";
  const params = saison ? [saison] : [];
  const r = await query<{ n: string }>(`SELECT count(*)::bigint AS n FROM raw.${table} ${where}`, params);
  return Number(r.rows[0]!.n);
}

// CTE `ranked` : numérote les captures par natural_key, de la plus récente (rn=1) à la plus ancienne.
function ranked(table: string, saison: string | undefined): { cte: string; params: unknown[] } {
  const where = saison ? "WHERE saison = $1" : "";
  const params: unknown[] = saison ? [saison] : [];
  const cte = `WITH ranked AS (
      SELECT id, scraped_at,
             row_number() OVER (PARTITION BY natural_key ORDER BY scraped_at DESC, id DESC) AS rn
        FROM raw.${table} ${where}
    )`;
  return { cte, params };
}

function predicate(mode: "keep" | "age", paramIdx: number): string {
  return mode === "keep"
    ? `r.rn > $${paramIdx}`
    : `r.rn > 1 AND r.scraped_at < now() - ($${paramIdx} * interval '1 day')`;
}

async function planTable(
  table: string,
  saison: string | undefined,
  mode: "keep" | "age",
  threshold: number,
  apply: boolean,
): Promise<Plan> {
  const total = await countTotal(table, saison);
  const { cte, params } = ranked(table, saison);
  const idx = params.length + 1;
  const pred = predicate(mode, idx).replace(/\br\./g, ""); // dans le SELECT, ranked est la source directe

  const countRes = await query<{ n: string }>(
    `${cte} SELECT count(*)::bigint AS n FROM ranked WHERE ${pred}`,
    [...params, threshold],
  );
  const toDelete = Number(countRes.rows[0]!.n);

  let deleted: number | null = null;
  if (apply && toDelete > 0) {
    const delRes = await query(
      `${cte} DELETE FROM raw.${table} t USING ranked r WHERE t.id = r.id AND ${predicate(mode, idx)}`,
      [...params, threshold],
    );
    deleted = delRes.rowCount ?? 0;
  }
  return { table, total, toDelete, deleted };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      keep: { type: "string" },
      "older-than-days": { type: "string" },
      saison: { type: "string" },
      table: { type: "string" },
      apply: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  });
  initColor(values["no-color"] === true ? false : undefined);

  const apply = values.apply === true;
  const saison = values.saison ? canonicalizeSaison(values.saison) : undefined;

  let mode: "keep" | "age";
  let threshold: number;
  if (values["older-than-days"] !== undefined) {
    mode = "age";
    threshold = Number(values["older-than-days"]);
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("--older-than-days doit être un entier positif");
  } else {
    mode = "keep";
    threshold = values.keep !== undefined ? Number(values.keep) : 3;
    if (!Number.isInteger(threshold) || threshold < 1) throw new Error("--keep doit être un entier ≥ 1");
  }

  let tables: readonly string[] = RAW_TABLES;
  if (values.table !== undefined) {
    if (!RAW_TABLES.includes(values.table as (typeof RAW_TABLES)[number])) {
      throw new Error(`--table inconnue : ${values.table}. Valides : ${RAW_TABLES.join(", ")}`);
    }
    tables = [values.table];
  }

  const modeLabel =
    mode === "keep"
      ? `garder ${threshold} capture(s)/clé`
      : `> ${threshold} j (garde la plus récente)`;
  process.stdout.write(
    `\n${col.bold("Rétention raw")} · ${modeLabel}` +
      (saison ? ` · saison ${saison}` : " · toutes saisons") +
      ` · ${apply ? col.red("APPLY") : col.yellow("DRY-RUN")}\n`,
  );

  const plans: Plan[] = [];
  let errors = 0;
  for (const t of tables) {
    try {
      plans.push(await planTable(t, saison, mode, threshold, apply));
    } catch (err) {
      errors++;
      process.stdout.write(`  ${col.red("✗")} ${t} — ${describeError(err)}\n`);
    }
  }
  // Échec global si AUCUNE table n'a pu être traitée (ex. base injoignable) → exit non nul.
  if (errors === tables.length && tables.length > 0) {
    process.exitCode = 1;
    return;
  }

  // Tableau aligné.
  const rows = plans.map((p) => {
    const acted = apply ? (p.deleted ?? 0) : p.toDelete;
    const remaining = p.total - acted;
    return {
      table: p.table,
      total: num(p.total),
      acted: acted > 0 ? col.yellow(num(acted)) : col.dim("0"),
      remaining: num(remaining),
    };
  });
  const wT = Math.max("table".length, ...rows.map((r) => r.table.length));
  const wTot = Math.max("lignes".length, ...plans.map((p) => num(p.total).length));
  const actHeader = apply ? "purgé" : "à purger";
  process.stdout.write(
    col.dim(`  ${"table".padEnd(wT)}  ${"lignes".padStart(wTot)}  ${actHeader.padStart(9)}  ${"restant".padStart(wTot)}\n`),
  );
  let totDel = 0;
  let totBefore = 0;
  for (const r of rows) {
    const p = plans.find((x) => x.table === r.table)!;
    totDel += apply ? (p.deleted ?? 0) : p.toDelete;
    totBefore += p.total;
    // padStart sur la largeur visible : on neutralise les codes couleur dans le calcul.
    const pad = (s: string, w: number) => " ".repeat(Math.max(0, w - s.replace(/\x1b\[[0-9;]*m/g, "").length)) + s;
    process.stdout.write(
      `  ${r.table.padEnd(wT)}  ${pad(r.total, wTot)}  ${pad(r.acted, 9)}  ${pad(r.remaining, wTot)}\n`,
    );
  }
  process.stdout.write(
    `\n${apply ? col.green(`✓ ${num(totDel)} ligne(s) purgée(s)`) : col.yellow(`${num(totDel)} ligne(s) à purger`)}` +
      col.dim(` sur ${num(totBefore)} (saison${saison ? ` ${saison}` : "s"}).`) +
      (apply ? col.dim("  Pense à `pnpm maintenance` (VACUUM) pour récupérer l'espace.\n") : col.dim("  Ajoute --apply pour exécuter.\n")),
  );
}

main()
  .catch((err) => {
    process.stderr.write(`${col.red("Erreur prune-raw")} : ${describeError(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
