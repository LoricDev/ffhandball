import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";

const SCRAPE_ENTITIES = [
  "clubs",
  "club-details",
  "competitions",
  "matchs",
  "classements",
  "stats-joueurs",
  "feuilles-match",
] as const;

const ETL_ENTITIES = [
  "salles",
  "clubs",
  "competitions",
  "phases",
  "poules",
  "equipes",
  "engagements",
  "matchs",
  "arbitres",
  "match_officiels",
  "classements",
  "stats-joueurs",
  "feuilles-match",
] as const;

interface ScrapeRow {
  scraper_name: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  pages_scraped: number;
  error_message: string | null;
}

interface EtlRow {
  entity: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  inserted: number | null;
  updated: number | null;
  rejected: number | null;
  error_message: string | null;
}

function fmt(d: Date | null): string {
  if (!d) return "-";
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function statusIcon(status: string): string {
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  if (status === "partial") return "~";
  return "…";
}

function col(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { saison: { type: "string" } },
  });
  if (!values.saison) throw new Error("--saison requis");
  const saison = canonicalizeSaison(values.saison);

  // --- Scrapes ---
  const scrapeRes = await query<ScrapeRow>(
    `SELECT scraper_name, status, started_at, finished_at, pages_scraped, error_message
       FROM raw.scrape_runs
      WHERE saison = $1
      ORDER BY scraper_name, started_at DESC`,
    [saison],
  );

  // Keep only the last run per scraper
  const latestScrape = new Map<string, ScrapeRow>();
  for (const row of scrapeRes.rows) {
    if (!latestScrape.has(row.scraper_name)) latestScrape.set(row.scraper_name, row);
  }

  process.stdout.write(`\nSaison : ${saison}\n`);
  process.stdout.write("─".repeat(72) + "\n");
  process.stdout.write("SCRAPE\n");
  process.stdout.write("─".repeat(72) + "\n");
  process.stdout.write(
    `  ${col("entity", 16)} ${col("status", 9)} ${col("démarré", 20)} ${col("pages", 6)}\n`,
  );
  process.stdout.write("  " + "─".repeat(68) + "\n");

  for (const entity of SCRAPE_ENTITIES) {
    const scraperName = entity === "clubs" ? "clubs"
      : entity === "club-details" ? "club-details"
      : entity === "competitions" ? "competitions"
      : entity === "matchs" ? "matchs"
      : entity === "classements" ? "classements"
      : entity === "stats-joueurs" ? "stats-joueurs"
      : "feuilles-match";

    const row = latestScrape.get(scraperName);
    if (!row) {
      process.stdout.write(`  ${col(entity, 16)} ${col("—", 9)} ${"—"}\n`);
    } else {
      const icon = statusIcon(row.status);
      const pages = String(row.pages_scraped);
      process.stdout.write(
        `  ${col(entity, 16)} ${icon} ${col(row.status, 8)} ${col(fmt(row.started_at), 20)} ${col(pages, 6)}`,
      );
      if (row.error_message) {
        process.stdout.write(`  ⚠ ${row.error_message.slice(0, 40)}`);
      }
      process.stdout.write("\n");
    }
  }

  // --- ETL ---
  const etlRes = await query<EtlRow>(
    `SELECT entity, status, started_at, finished_at, inserted, updated, rejected, error_message
       FROM core.etl_runs
      WHERE saison = $1
      ORDER BY entity, started_at DESC`,
    [saison],
  );

  const latestEtl = new Map<string, EtlRow>();
  for (const row of etlRes.rows) {
    if (!latestEtl.has(row.entity)) latestEtl.set(row.entity, row);
  }

  process.stdout.write("\n");
  process.stdout.write("ETL\n");
  process.stdout.write("─".repeat(72) + "\n");
  process.stdout.write(
    `  ${col("entity", 16)} ${col("status", 9)} ${col("démarré", 20)} ${col("ins", 6)} ${col("upd", 6)} ${col("rej", 6)}\n`,
  );
  process.stdout.write("  " + "─".repeat(68) + "\n");

  for (const entity of ETL_ENTITIES) {
    const row = latestEtl.get(entity);
    if (!row) {
      process.stdout.write(`  ${col(entity, 16)} ${col("—", 9)} ${"—"}\n`);
    } else {
      const icon = statusIcon(row.status);
      process.stdout.write(
        `  ${col(entity, 16)} ${icon} ${col(row.status, 8)} ${col(fmt(row.started_at), 20)} ${col(String(row.inserted ?? "-"), 6)} ${col(String(row.updated ?? "-"), 6)} ${col(String(row.rejected ?? "-"), 6)}`,
      );
      if (row.error_message) {
        process.stdout.write(`  ⚠ ${row.error_message.slice(0, 40)}`);
      }
      process.stdout.write("\n");
    }
  }

  process.stdout.write("\n");
}

main()
  .catch((err) => {
    process.stderr.write(`Erreur : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
