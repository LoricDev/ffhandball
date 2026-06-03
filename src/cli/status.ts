// src/cli/status.ts — état du pipeline (scrape + ETL) et volumétrie pour une saison.
// Usage : pnpm status [--saison=2025-2026] [--json]
//
// --saison  : saison à inspecter. Si omis, prend la saison la plus récente présente en base.
// --json    : sortie JSON brute (pour monitoring / automatisation).
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

// Tables de capture raw (toutes possèdent les colonnes saison + natural_key).
const RAW_TABLES = [
  "clubs",
  "equipes",
  "joueurs",
  "competitions",
  "matchs",
  "feuilles_match",
  "classements",
  "arbitres",
  "salles",
] as const;

// Ordre d'affichage préféré des tables core (volumétrie). Les tables inconnues finissent à la fin.
const CORE_ORDER = [
  "saisons", "ligues", "departements", "salles", "clubs", "joueurs",
  "competitions", "phases", "poules", "equipes", "engagements",
  "matchs", "arbitres", "match_officiels", "classements",
  "match_actions", "match_compositions", "stats_joueurs", "licences",
];

// Tables core techniques/admin exclues de la volumétrie métier.
const CORE_EXCLUDE = new Set([
  "etl_runs", "etl_rejets", "etl_warnings", "alias_clubs", "api_keys", "api_logs",
]);

interface ScrapeRow {
  scraper_name: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  pages_scraped: number;
  pages_total: number | null;
  error_message: string | null;
}

interface EtlRow {
  entity: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  rows_read: number | null;
  rows_inserted: number | null;
  rows_updated: number | null;
  rows_rejected: number | null;
  warnings_count: number | null;
  error_message: string | null;
}

interface RawVolume {
  table: string;
  total: number;
  uniques: number;
  last: Date | null;
}

interface CoreVolume {
  table: string;
  count: number;
  saisonFiltered: boolean;
}

interface Tally {
  success: number;
  partial: number;
  failed: number;
  running: number;
  other: number;
}

// ── Formatage ────────────────────────────────────────────────────────────────

function fmtDate(d: Date | null): string {
  if (!d) return "-";
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function fmtDuration(start: Date | null, end: Date | null, status: string): string {
  if (!start) return "-";
  if (!end) return status === "running" ? "en cours" : "-";
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

function fmtAge(d: Date | null): string {
  if (!d) return "-";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const j = Math.floor(h / 24);
  return `${j}j`;
}

function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function statusIcon(status: string): string {
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  if (status === "partial") return "~";
  if (status === "running") return "…";
  return "·";
}

function col(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

// Le CLI/scrape nomment les entités avec des tirets (stats-joueurs, feuilles-match),
// mais certains ETL persistent leur `entity` avec des underscores (stats_joueurs,
// feuilles_match). On normalise pour rapprocher les deux conventions.
function normEntity(s: string): string {
  return s.replace(/-/g, "_");
}

function durationSec(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / 1000);
}

function tally(rows: { status: string }[]): Tally {
  const t: Tally = { success: 0, partial: 0, failed: 0, running: 0, other: 0 };
  for (const r of rows) {
    if (r.status === "success") t.success++;
    else if (r.status === "partial") t.partial++;
    else if (r.status === "failed") t.failed++;
    else if (r.status === "running") t.running++;
    else t.other++;
  }
  return t;
}

function lastActivity(rows: { finished_at: Date | null; started_at: Date }[]): Date | null {
  let max: Date | null = null;
  for (const r of rows) {
    const d = r.finished_at ?? r.started_at;
    if (!max || d.getTime() > max.getTime()) max = d;
  }
  return max;
}

const W = 80;
function out(s = ""): void {
  process.stdout.write(s + "\n");
}

type Align = "l" | "r";
interface Column {
  header: string;
  align: Align;
}

// Rend une section tabulaire à largeurs dynamiques : chaque colonne est dimensionnée
// sur la plus longue valeur réelle (en-tête comprise), donc aucune valeur n'est jamais
// tronquée — contrairement à un padding fixe qui corromprait les grands nombres groupés.
function renderTable(
  title: string,
  columns: Column[],
  rows: string[][],
  totals?: string[],
): void {
  const all = totals ? [...rows, totals] : rows;
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...all.map((r) => (r[i] ?? "").length)),
  );
  const fit = (s: string, i: number): string =>
    columns[i]!.align === "r" ? s.padStart(widths[i]!) : s.padEnd(widths[i]!);
  const indent = "  ";
  const gap = "  ";
  const line = (cells: string[]): string =>
    (indent + columns.map((c, i) => fit(cells[i] ?? "", i)).join(gap)).replace(/\s+$/u, "");
  const innerRule =
    indent + widths.map((w) => "─".repeat(w)).join("─".repeat(gap.length));
  const width = Math.max(W, indent.length + widths.reduce((a, b) => a + b, 0) + gap.length * (widths.length - 1));

  out();
  out("─".repeat(width));
  out(title);
  out("─".repeat(width));
  out(line(columns.map((c) => c.header)));
  out(innerRule);
  for (const r of rows) out(line(r));
  if (totals) {
    out(innerRule);
    out(line(totals));
  }
}

// ── Collecte ─────────────────────────────────────────────────────────────────

async function listSaisons(): Promise<{ saison: string; last: Date; runs: number }[]> {
  const res = await query<{ saison: string; last: Date; runs: string }>(
    `SELECT saison, max(ts) AS last, count(*)::bigint AS runs
       FROM (
         SELECT saison, started_at AS ts FROM raw.scrape_runs
         UNION ALL
         SELECT saison, started_at FROM core.etl_runs WHERE saison IS NOT NULL
       ) u
      GROUP BY saison
      ORDER BY max(ts) DESC`,
  );
  return res.rows.map((r) => ({ saison: r.saison, last: r.last, runs: Number(r.runs) }));
}

async function rawVolume(table: string, saison: string): Promise<RawVolume | null> {
  if (!/^[a-z_]+$/.test(table)) return null;
  try {
    const r = await query<{ total: string; uniq: string; last: Date | null }>(
      `SELECT count(*)::bigint AS total,
              count(DISTINCT natural_key)::bigint AS uniq,
              max(scraped_at) AS last
         FROM raw.${table}
        WHERE saison = $1`,
      [saison],
    );
    const row = r.rows[0]!;
    return { table, total: Number(row.total), uniques: Number(row.uniq), last: row.last };
  } catch {
    return null;
  }
}

async function coreVolume(table: string, saison: string, filtered: boolean): Promise<CoreVolume | null> {
  if (!/^[a-z_]+$/.test(table)) return null;
  try {
    const where = filtered ? " WHERE saison_code = $1" : "";
    const params = filtered ? [saison] : [];
    const r = await query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM core.${table}${where}`,
      params,
    );
    return { table, count: Number(r.rows[0]!.n), saisonFiltered: filtered };
  } catch {
    return null;
  }
}

async function coreTables(): Promise<{ table: string; hasSaison: boolean }[]> {
  const tblRes = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'core' AND table_type = 'BASE TABLE'`,
  );
  const colRes = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'core' AND column_name = 'saison_code'`,
  );
  const hasSaison = new Set(colRes.rows.map((r) => r.table_name));
  const tables = tblRes.rows
    .map((r) => r.table_name)
    .filter((t) => !CORE_EXCLUDE.has(t))
    .sort((a, b) => {
      const ia = CORE_ORDER.indexOf(a);
      const ib = CORE_ORDER.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b);
    });
  return tables.map((t) => ({ table: t, hasSaison: hasSaison.has(t) }));
}

// ── Rendu texte ──────────────────────────────────────────────────────────────

function renderHeader(
  saison: string,
  saisons: { saison: string; last: Date; runs: number }[],
  scrapeRows: ScrapeRow[],
  etlRows: EtlRow[],
  latestScrape: ScrapeRow[],
  latestEtl: EtlRow[],
): void {
  const ts = tally(latestScrape);
  const te = tally(latestEtl);
  out();
  out("═".repeat(W));
  out(` STATUS — saison ${saison}${col("", Math.max(0, W - 18 - saison.length - 17))}${fmtDate(new Date())}`);
  out("═".repeat(W));
  out(
    ` Scrape   ✓${ts.success}  ~${ts.partial}  ✗${ts.failed}` +
      `   · ${ts.running} en cours · ${scrapeRows.length} runs · dernier ${fmtAge(lastActivity(latestScrape))}`,
  );
  out(
    ` ETL      ✓${te.success}  ~${te.partial}  ✗${te.failed}` +
      `   · ${te.running} en cours · ${etlRows.length} runs · dernier ${fmtAge(lastActivity(latestEtl))}`,
  );
  if (saisons.length > 0) {
    const dispo = saisons
      .map((s) => (s.saison === saison ? `${s.saison} (active)` : s.saison))
      .join(", ");
    out(` Saisons  ${dispo}`);
  }
}

function renderScrape(latestScrape: Map<string, ScrapeRow>): void {
  const cols: Column[] = [
    { header: "entity", align: "l" },
    { header: "état", align: "l" },
    { header: "démarré", align: "l" },
    { header: "durée", align: "l" },
    { header: "pages", align: "r" },
    { header: "âge", align: "r" },
  ];
  const rows = SCRAPE_ENTITIES.map((entity) => {
    const row = latestScrape.get(entity);
    if (!row) return [entity, "—", "", "", "", ""];
    let duree = fmtDuration(row.started_at, row.finished_at, row.status);
    if (row.status === "running" && row.pages_total && row.pages_total > 0) {
      const pct = Math.min(99, Math.floor((row.pages_scraped / row.pages_total) * 100));
      duree = `${pct}% en cours`;
    }
    return [
      entity,
      `${statusIcon(row.status)} ${row.status}`,
      fmtDate(row.started_at),
      duree,
      num(row.pages_scraped),
      fmtAge(row.finished_at ?? row.started_at),
    ];
  });
  renderTable("SCRAPE", cols, rows);
}

function renderEtl(latestEtl: Map<string, EtlRow>, progress: Map<string, number>): void {
  const cols: Column[] = [
    { header: "entity", align: "l" },
    { header: "état", align: "l" },
    { header: "démarré", align: "l" },
    { header: "durée", align: "l" },
    { header: "read", align: "r" },
    { header: "ins", align: "r" },
    { header: "upd", align: "r" },
    { header: "rej", align: "r" },
    { header: "warn", align: "r" },
  ];
  const toRow = (label: string, row: EtlRow | undefined): string[] => {
    if (!row) return [label, "—", "", "", "", "", "", "", ""];
    let duree = fmtDuration(row.started_at, row.finished_at, row.status);
    if (row.status === "running") {
      const pct = progress.get(normEntity(row.entity));
      if (pct !== undefined) duree = `${pct}% en cours`;
    }
    return [
      label,
      `${statusIcon(row.status)} ${row.status}`,
      fmtDate(row.started_at),
      duree,
      num(row.rows_read),
      num(row.rows_inserted),
      num(row.rows_updated),
      num(row.rows_rejected),
      num(row.warnings_count),
    ];
  };

  // latestEtl est indexée par nom d'entité normalisé : on retrouve donc
  // stats-joueurs ↔ stats_joueurs et feuilles-match ↔ feuilles_match.
  const known = new Set(ETL_ENTITIES.map(normEntity));
  const rows = ETL_ENTITIES.map((entity) => toRow(entity, latestEtl.get(normEntity(entity))));

  // Garde-fou : tout run présent en base mais absent de la liste connue est affiché
  // (avec son nom réel) plutôt que masqué — évite qu'un renommage cache des données.
  for (const [key, row] of latestEtl) {
    if (!known.has(key)) rows.push(toRow(row.entity, row));
  }

  renderTable("ETL", cols, rows);
}

function renderRawVolume(saison: string, rows: RawVolume[]): void {
  const cols: Column[] = [
    { header: "table", align: "l" },
    { header: "lignes", align: "r" },
    { header: "uniques", align: "r" },
    { header: "dernière capture", align: "l" },
  ];
  let totLignes = 0;
  let totUniques = 0;
  const body = rows.map((r) => {
    totLignes += r.total;
    totUniques += r.uniques;
    return [r.table, num(r.total), num(r.uniques), fmtDate(r.last)];
  });
  renderTable(
    `VOLUMÉTRIE RAW — saison ${saison} (lignes capturées, append-only)`,
    cols,
    body,
    ["TOTAL", num(totLignes), num(totUniques), ""],
  );
}

function renderCoreVolume(saison: string, rows: CoreVolume[]): void {
  const cols: Column[] = [
    { header: "table", align: "l" },
    { header: "lignes", align: "r" },
    { header: "filtre", align: "l" },
  ];
  const body = rows.map((r) => [
    r.table,
    num(r.count),
    r.saisonFiltered ? "saison" : "global",
  ]);
  renderTable("VOLUMÉTRIE CORE (données normalisées)", cols, body);
  out(`  (filtre « saison » = compté pour ${saison} ; « global » = table référentielle non filtrable par saison)`);
}

function renderIncidents(latestScrape: ScrapeRow[], latestEtl: EtlRow[]): void {
  const incidents: string[] = [];
  for (const r of latestScrape) {
    if ((r.status === "failed" || r.status === "partial") && r.error_message) {
      incidents.push(`  ${statusIcon(r.status)} scrape ${r.scraper_name} — ${r.error_message.slice(0, 100)}`);
    }
  }
  for (const r of latestEtl) {
    if ((r.status === "failed" || r.status === "partial") && r.error_message) {
      incidents.push(`  ${statusIcon(r.status)} etl ${r.entity} — ${r.error_message.slice(0, 100)}`);
    }
  }
  if (incidents.length === 0) return;
  out();
  out("─".repeat(W));
  out(`INCIDENTS (${incidents.length})`);
  out("─".repeat(W));
  for (const line of incidents) out(line);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      saison: { type: "string" },
      json: { type: "boolean" },
    },
  });

  const saisons = await listSaisons();

  let saison: string;
  if (values.saison) {
    saison = canonicalizeSaison(values.saison);
  } else if (saisons.length > 0) {
    saison = saisons[0]!.saison;
  } else {
    throw new Error("Aucune donnée en base. Précisez --saison ou lancez un scrape.");
  }

  // --- Scrapes : dernière exécution par scraper ---
  // pages_total (migration 0020) peut ne pas exister si la migration n'est pas encore passée :
  // un outil de monitoring ne doit pas crasher pour autant → on l'inclut seulement si présente.
  const hasPagesTotal =
    (
      await query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'raw' AND table_name = 'scrape_runs' AND column_name = 'pages_total'`,
      )
    ).rows.length > 0;
  const scrapeRes = await query<ScrapeRow>(
    `SELECT scraper_name, status, started_at, finished_at, pages_scraped,
            ${hasPagesTotal ? "pages_total" : "NULL::int AS pages_total"}, error_message
       FROM raw.scrape_runs
      WHERE saison = $1
      ORDER BY scraper_name, started_at DESC`,
    [saison],
  );
  const latestScrape = new Map<string, ScrapeRow>();
  for (const row of scrapeRes.rows) {
    if (!latestScrape.has(row.scraper_name)) latestScrape.set(row.scraper_name, row);
  }

  // --- ETL : dernière exécution par entité ---
  const etlRes = await query<EtlRow>(
    `SELECT entity, status, started_at, finished_at,
            rows_read, rows_inserted, rows_updated, rows_rejected, warnings_count, error_message
       FROM core.etl_runs
      WHERE saison = $1
      ORDER BY entity, started_at DESC`,
    [saison],
  );
  // Indexée par nom normalisé pour tolérer tiret/underscore (stats-joueurs ↔ stats_joueurs).
  const latestEtl = new Map<string, EtlRow>();
  for (const row of etlRes.rows) {
    const key = normEntity(row.entity);
    if (!latestEtl.has(key)) latestEtl.set(key, row);
  }

  // --- Volumétrie (requêtes concurrentes) ---
  const rawVol = (await Promise.all(RAW_TABLES.map((t) => rawVolume(t, saison)))).filter(
    (r): r is RawVolume => r !== null,
  );
  const coreDefs = await coreTables();
  const coreVol = (
    await Promise.all(coreDefs.map((d) => coreVolume(d.table, saison, d.hasSaison)))
  ).filter((r): r is CoreVolume => r !== null);

  const latestScrapeArr = [...latestScrape.values()];
  const latestEtlArr = [...latestEtl.values()];

  // Avancement des ETL EN COURS (% = rows_read checkpointé / total de lignes raw distinctes),
  // pour les entités traitées en streaming (matchs, classements, stats, feuilles).
  const STREAMING_RAW: Record<string, string> = {
    matchs: "raw.matchs",
    classements: "raw.classements",
    stats_joueurs: "raw.stats_joueurs",
    feuilles_match: "raw.feuilles_match",
  };
  const etlProgress = new Map<string, number>();
  for (const [key, row] of latestEtl) {
    const table = STREAMING_RAW[key];
    if (row.status !== "running" || !table) continue;
    const r = await query<{ n: string }>(
      `SELECT count(DISTINCT natural_key)::bigint AS n FROM ${table} WHERE saison = $1`,
      [saison],
    );
    const total = Number(r.rows[0]?.n ?? 0);
    if (total > 0) etlProgress.set(key, Math.min(99, Math.floor(((row.rows_read ?? 0) / total) * 100)));
  }

  if (values.json) {
    out(
      JSON.stringify(
        {
          saison,
          generatedAt: new Date().toISOString(),
          saisonsDisponibles: saisons.map((s) => ({
            saison: s.saison,
            dernierRun: s.last.toISOString(),
            runs: s.runs,
          })),
          resume: {
            scrape: { ...tally(latestScrapeArr), runsTotal: scrapeRes.rows.length },
            etl: { ...tally(latestEtlArr), runsTotal: etlRes.rows.length },
          },
          scrape: SCRAPE_ENTITIES.map((entity) => {
            const r = latestScrape.get(entity);
            return r
              ? {
                  entity,
                  status: r.status,
                  startedAt: r.started_at.toISOString(),
                  finishedAt: r.finished_at?.toISOString() ?? null,
                  durationSec: durationSec(r.started_at, r.finished_at),
                  pages: r.pages_scraped,
                  pagesTotal: r.pages_total,
                  error: r.error_message,
                }
              : { entity, status: null };
          }),
          etl: ETL_ENTITIES.map((entity) => {
            const r = latestEtl.get(normEntity(entity));
            return r
              ? {
                  entity,
                  status: r.status,
                  startedAt: r.started_at.toISOString(),
                  finishedAt: r.finished_at?.toISOString() ?? null,
                  durationSec: durationSec(r.started_at, r.finished_at),
                  rowsRead: r.rows_read,
                  rowsInserted: r.rows_inserted,
                  rowsUpdated: r.rows_updated,
                  rowsRejected: r.rows_rejected,
                  warnings: r.warnings_count,
                  error: r.error_message,
                }
              : { entity, status: null };
          }),
          volumetrieRaw: rawVol.map((r) => ({
            table: r.table,
            total: r.total,
            uniques: r.uniques,
            lastCapture: r.last?.toISOString() ?? null,
          })),
          volumetrieCore: coreVol,
        },
        null,
        2,
      ),
    );
    return;
  }

  renderHeader(saison, saisons, scrapeRes.rows, etlRes.rows, latestScrapeArr, latestEtlArr);
  renderScrape(latestScrape);
  renderEtl(latestEtl, etlProgress);
  renderRawVolume(saison, rawVol);
  renderCoreVolume(saison, coreVol);
  renderIncidents(latestScrapeArr, latestEtlArr);
  out();
}

function describeError(err: unknown): string {
  // pg lève une AggregateError (message vide) quand aucun host n'est joignable.
  if (err instanceof AggregateError) {
    const codes = err.errors.map((e) => (e as { code?: string }).code).filter(Boolean);
    const msgs = err.errors.map((e) => (e instanceof Error ? e.message : String(e)));
    const detail = msgs[0] ?? "connexion impossible";
    if (codes.includes("ECONNREFUSED")) {
      return `base de données injoignable (${detail}). Vérifiez que Postgres tourne et DATABASE_URL.`;
    }
    return detail;
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === "ECONNREFUSED") {
      return `base de données injoignable (${err.message}). Vérifiez que Postgres tourne et DATABASE_URL.`;
    }
    return err.message || code || String(err);
  }
  return String(err);
}

main()
  .catch((err) => {
    process.stderr.write(`Erreur : ${describeError(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
