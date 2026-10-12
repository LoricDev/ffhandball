// src/cli/status.ts — état du pipeline (scrape + ETL) et volumétrie pour une saison.
// Usage : pnpm status [--saison=2025-2026] [--json] [--no-color]
//
// --saison    : saison à inspecter. Si omis, prend la saison la plus récente présente en base.
// --json      : sortie JSON brute (pour monitoring / automatisation). Désactive la couleur.
// --no-color  : force la sortie sans couleur (sinon couleur auto si TTY et NO_COLOR absent).
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

// Correspondance raw → core (même nom) pour mesurer la promotion ETL (couverture).
const COVERAGE_TABLES = [
  "clubs", "equipes", "joueurs", "competitions", "matchs", "classements", "arbitres", "salles",
] as const;

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

interface DbTable {
  schema: string;
  table: string;
  bytes: number;
  rows: number | null;
}

interface DbInfo {
  total: number;
  tables: DbTable[];
}

interface CoverageRow {
  entity: string;
  rawUniques: number;
  coreCount: number;
}

interface Tally {
  success: number;
  partial: number;
  failed: number;
  running: number;
  other: number;
}

// ── Couleur (ANSI) ─────────────────────────────────────────────────────────────
// Activée seulement si la sortie est un TTY (désactivée si pipe/redirection, --json,
// --no-color ou NO_COLOR). On colore APRÈS calcul des largeurs : renderTable mesure la
// longueur VISIBLE (codes ANSI ignorés) pour ne jamais casser l'alignement des colonnes.
let COLOR = false;
function setColor(on: boolean): void {
  COLOR = on;
}
const ESC = "\x1b[";
function paint(code: string, s: string): string {
  return COLOR ? `${ESC}${code}m${s}${ESC}0m` : s;
}
const c = {
  bold: (s: string) => paint("1", s),
  dim: (s: string) => paint("2", s),
  red: (s: string) => paint("31", s),
  green: (s: string) => paint("32", s),
  yellow: (s: string) => paint("33", s),
  blue: (s: string) => paint("34", s),
  magenta: (s: string) => paint("35", s),
  cyan: (s: string) => paint("36", s),
  gray: (s: string) => paint("90", s),
};
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

// ── Formatage ────────────────────────────────────────────────────────────────

function fmtDate(d: Date | null): string {
  if (!d) return "-";
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function fmtMs(ms: number): string {
  if (ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

function fmtDuration(start: Date | null, end: Date | null, status: string): string {
  if (!start) return "-";
  if (!end) return status === "running" ? "en cours" : "-";
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return "-";
  return fmtMs(ms);
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

function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return "-";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

// Débit lisible : >=10/s → "N/s", >=1/s → "N.N/s", sinon bascule sur /min ou /h.
function fmtRate(count: number | null | undefined, sec: number | null): string {
  if (count === null || count === undefined || !sec || sec <= 0) return "-";
  const r = count / sec;
  if (r >= 10) return `${Math.round(r)}/s`;
  if (r >= 1) return `${r.toFixed(1)}/s`;
  const perMin = r * 60;
  if (perMin >= 1) return `${Math.round(perMin)}/min`;
  return `${Math.round(r * 3600)}/h`;
}

function statusIcon(status: string): string {
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  if (status === "partial") return "~";
  if (status === "running") return "…";
  return "·";
}

// Cellule « état » colorée selon le statut.
function statusCell(status: string): string {
  const txt = `${statusIcon(status)} ${status}`;
  if (status === "success") return c.green(txt);
  if (status === "failed") return c.red(txt);
  if (status === "partial") return c.yellow(txt);
  if (status === "running") return c.cyan(txt);
  return c.gray(txt);
}

// Cellule « âge » colorée par fraîcheur (vert <1j, neutre <3j, jaune <7j, rouge au-delà).
function ageCell(d: Date | null): string {
  const s = fmtAge(d);
  if (!d) return c.gray(s);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days > 7) return c.red(s);
  if (days > 3) return c.yellow(s);
  if (days > 1) return s;
  return c.green(s);
}

// Barre de progression / magnitude en blocs unicode.
function bar(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function magnitudeBar(value: number, max: number, width = 10): string {
  if (max <= 0) return c.dim("░".repeat(width));
  return c.dim(bar((value / max) * 100, width));
}

// Cellule de progression d'un job en cours : barre + % + ETA estimée.
function progressCell(pct: number, start: Date): string {
  const elapsed = Date.now() - start.getTime();
  const etaStr = pct > 0 && pct < 100 ? fmtMs((elapsed * (100 - pct)) / pct) : "";
  return `${c.cyan(bar(pct))} ${pct}%${etaStr ? ` ${c.dim(`ETA ${etaStr}`)}` : ""}`;
}

function durationSec(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / 1000);
}

// Le CLI/scrape nomment les entités avec des tirets (stats-joueurs, feuilles-match),
// mais certains ETL persistent leur `entity` avec des underscores (stats_joueurs,
// feuilles_match). On normalise pour rapprocher les deux conventions.
function normEntity(s: string): string {
  return s.replace(/-/g, "_");
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

// Verdict global de santé du pipeline.
function healthVerdict(
  ts: Tally,
  te: Tally,
  staleCount: number,
): { icon: string; label: string; color: (s: string) => string } {
  if (ts.failed > 0 || te.failed > 0) return { icon: "✗", label: "en échec", color: c.red };
  if (ts.running > 0 || te.running > 0) return { icon: "…", label: "en cours", color: c.cyan };
  if (ts.partial > 0 || te.partial > 0 || staleCount > 0)
    return { icon: "~", label: "dégradé", color: c.yellow };
  return { icon: "✓", label: "sain", color: c.green };
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

// Pad sur la largeur VISIBLE (les codes ANSI ne comptent pas), pour aligner des cellules colorées.
function padVis(s: string, width: number, align: Align): string {
  const pad = Math.max(0, width - visLen(s));
  return align === "r" ? " ".repeat(pad) + s : s + " ".repeat(pad);
}

// Rend une section tabulaire à largeurs dynamiques : chaque colonne est dimensionnée
// sur la plus longue valeur RÉELLE (en-tête comprise, largeur visible), donc aucune valeur
// n'est jamais tronquée — contrairement à un padding fixe qui corromprait les grands nombres.
function renderTable(
  title: string,
  columns: Column[],
  rows: string[][],
  totals?: string[],
): void {
  const all = totals ? [...rows, totals] : rows;
  const widths = columns.map((col, i) =>
    Math.max(visLen(col.header), ...all.map((r) => visLen(r[i] ?? ""))),
  );
  const indent = "  ";
  const gap = "  ";
  const line = (cells: string[]): string =>
    (indent + columns.map((col, i) => padVis(cells[i] ?? "", widths[i]!, col.align)).join(gap)).replace(
      /\s+$/u,
      "",
    );
  const innerRule = indent + widths.map((w) => "─".repeat(w)).join("─".repeat(gap.length));
  const width = Math.max(
    W,
    indent.length + widths.reduce((a, b) => a + b, 0) + gap.length * (widths.length - 1),
  );

  out();
  out(c.gray("─".repeat(width)));
  out(c.bold(c.cyan(title)));
  out(c.gray("─".repeat(width)));
  out(c.dim(line(columns.map((col) => col.header))));
  out(c.gray(innerRule));
  for (const r of rows) out(line(r));
  if (totals) {
    out(c.gray(innerRule));
    out(line(totals.map((t) => c.bold(t))));
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

// Taille de la base + top tables (raw/core) par taille totale. Best-effort : si pg_stat_user_tables
// n'est pas accessible (droits restreints), on renvoie null et la section est simplement omise.
async function dbSize(): Promise<DbInfo | null> {
  try {
    const tot = await query<{ b: string }>(
      `SELECT pg_database_size(current_database())::bigint AS b`,
    );
    const t = await query<{ schema: string; table: string; bytes: string; rows: string | null }>(
      `SELECT schemaname AS schema, relname AS "table",
              pg_total_relation_size(relid)::bigint AS bytes,
              n_live_tup::bigint AS rows
         FROM pg_stat_user_tables
        WHERE schemaname IN ('raw', 'core')
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 12`,
    );
    return {
      total: Number(tot.rows[0]!.b),
      tables: t.rows.map((r) => ({
        schema: r.schema,
        table: r.table,
        bytes: Number(r.bytes),
        rows: r.rows == null ? null : Number(r.rows),
      })),
    };
  } catch {
    return null;
  }
}

function buildCoverage(rawVol: RawVolume[], coreVol: CoreVolume[]): CoverageRow[] {
  const rawByT = new Map(rawVol.map((r) => [r.table, r]));
  const coreByT = new Map(coreVol.map((r) => [r.table, r]));
  const rows: CoverageRow[] = [];
  for (const t of COVERAGE_TABLES) {
    const rv = rawByT.get(t);
    const cv = coreByT.get(t);
    if (!rv && !cv) continue;
    rows.push({ entity: t, rawUniques: rv?.uniques ?? 0, coreCount: cv?.count ?? 0 });
  }
  return rows;
}

// ── Rendu texte ──────────────────────────────────────────────────────────────

function renderHeader(
  saison: string,
  saisons: { saison: string; last: Date; runs: number }[],
  scrapeRows: ScrapeRow[],
  etlRows: EtlRow[],
  latestScrape: ScrapeRow[],
  latestEtl: EtlRow[],
  db: DbInfo | null,
  coreTotalRows: number,
  staleCount: number,
): void {
  const ts = tally(latestScrape);
  const te = tally(latestEtl);
  const h = healthVerdict(ts, te, staleCount);
  out();
  out(c.gray("═".repeat(W)));
  out(
    ` ${c.bold("STATUS")} ${c.dim("·")} saison ${c.bold(saison)} ${c.dim("·")} ` +
      `${h.color(`${h.icon} ${h.label}`)} ${c.dim("·")} ${c.dim(fmtDate(new Date()))}`,
  );
  out(c.gray("═".repeat(W)));
  out(
    ` ${c.bold("Scrape")}  ${c.green(`✓${ts.success}`)} ${c.yellow(`~${ts.partial}`)} ${c.red(`✗${ts.failed}`)}` +
      `  ${c.dim("·")} ${c.cyan(`${ts.running} en cours`)} ${c.dim("·")} ${scrapeRows.length} runs ` +
      `${c.dim("·")} dernier ${ageCell(lastActivity(latestScrape))}`,
  );
  out(
    ` ${c.bold("ETL")}     ${c.green(`✓${te.success}`)} ${c.yellow(`~${te.partial}`)} ${c.red(`✗${te.failed}`)}` +
      `  ${c.dim("·")} ${c.cyan(`${te.running} en cours`)} ${c.dim("·")} ${etlRows.length} runs ` +
      `${c.dim("·")} dernier ${ageCell(lastActivity(latestEtl))}`,
  );
  const baseParts = [
    db ? `${c.bold(fmtBytes(db.total))} base` : null,
    `${c.bold(num(coreTotalRows))} lignes core`,
  ].filter(Boolean);
  out(` ${c.bold("Base")}    ${baseParts.join(` ${c.dim("·")} `)}`);
  if (saisons.length > 0) {
    const dispo = saisons
      .map((s) => (s.saison === saison ? c.green(`${s.saison} (active)`) : c.dim(s.saison)))
      .join(", ");
    out(` ${c.bold("Saisons")} ${dispo}`);
  }
}

function renderScrape(latestScrape: Map<string, ScrapeRow>): void {
  const cols: Column[] = [
    { header: "entity", align: "l" },
    { header: "état", align: "l" },
    { header: "démarré", align: "l" },
    { header: "durée / progression", align: "l" },
    { header: "pages", align: "r" },
    { header: "débit", align: "r" },
    { header: "âge", align: "r" },
  ];
  const rows = SCRAPE_ENTITIES.map((entity) => {
    const row = latestScrape.get(entity);
    if (!row) return [entity, c.gray("—"), "", "", "", "", ""];
    let duree = fmtDuration(row.started_at, row.finished_at, row.status);
    if (row.status === "running" && row.pages_total && row.pages_total > 0) {
      const pct = Math.min(99, Math.floor((row.pages_scraped / row.pages_total) * 100));
      duree = progressCell(pct, row.started_at);
    }
    const sec =
      durationSec(row.started_at, row.finished_at) ??
      (row.status === "running" ? Math.round((Date.now() - row.started_at.getTime()) / 1000) : null);
    return [
      entity,
      statusCell(row.status),
      fmtDate(row.started_at),
      duree,
      num(row.pages_scraped),
      c.dim(fmtRate(row.pages_scraped, sec)),
      ageCell(row.finished_at ?? row.started_at),
    ];
  });
  renderTable("SCRAPE  ·  dernière exécution par source", cols, rows);
}

function renderEtl(latestEtl: Map<string, EtlRow>, progress: Map<string, number>): void {
  const cols: Column[] = [
    { header: "entity", align: "l" },
    { header: "état", align: "l" },
    { header: "démarré", align: "l" },
    { header: "durée / progression", align: "l" },
    { header: "read", align: "r" },
    { header: "ins", align: "r" },
    { header: "upd", align: "r" },
    { header: "rej", align: "r" },
    { header: "warn", align: "r" },
    { header: "débit", align: "r" },
  ];
  const rejCell = (rej: number | null, read: number | null): string => {
    if (rej === null) return "-";
    const s = num(rej);
    if (rej === 0) return s;
    const rate = read && read > 0 ? rej / read : 0;
    return rate > 0.05 ? c.red(s) : c.yellow(s);
  };
  const toRow = (label: string, row: EtlRow | undefined): string[] => {
    if (!row) return [label, c.gray("—"), "", "", "", "", "", "", "", ""];
    let duree = fmtDuration(row.started_at, row.finished_at, row.status);
    if (row.status === "running") {
      const pct = progress.get(normEntity(row.entity));
      if (pct !== undefined) duree = progressCell(pct, row.started_at);
    }
    const sec = durationSec(row.started_at, row.finished_at);
    return [
      label,
      statusCell(row.status),
      fmtDate(row.started_at),
      duree,
      num(row.rows_read),
      num(row.rows_inserted),
      num(row.rows_updated),
      rejCell(row.rows_rejected, row.rows_read),
      row.warnings_count ? c.yellow(num(row.warnings_count)) : num(row.warnings_count),
      c.dim(fmtRate(row.rows_read, sec)),
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

  renderTable("ETL  ·  dernière exécution par entité", cols, rows);
}

function renderCoverage(rows: CoverageRow[]): void {
  if (rows.length === 0) return;
  const cols: Column[] = [
    { header: "entité", align: "l" },
    { header: "raw (uniques)", align: "r" },
    { header: "core", align: "r" },
    { header: "Δ", align: "r" },
    { header: "couverture", align: "l" },
  ];
  const body = rows.map((r) => {
    const delta = r.coreCount - r.rawUniques;
    const pct = r.rawUniques > 0 ? Math.round((r.coreCount / r.rawUniques) * 100) : r.coreCount > 0 ? 100 : 0;
    const pctTxt = `${pct}%`;
    const colored =
      pct >= 99 ? c.green(pctTxt) : pct >= 90 ? c.yellow(pctTxt) : c.red(pctTxt);
    const deltaTxt = delta === 0 ? c.dim("0") : delta > 0 ? `+${num(delta)}` : c.red(num(delta));
    return [
      r.entity,
      num(r.rawUniques),
      num(r.coreCount),
      deltaTxt,
      `${magnitudeBar(Math.min(pct, 100), 100)} ${colored}`,
    ];
  });
  renderTable("COUVERTURE raw → core  ·  taux de promotion ETL", cols, body);
  out(c.dim("  (core / raw-uniques ; Δ négatif = lignes raw non encore promues en core)"));
}

function renderRawVolume(saison: string, rows: RawVolume[]): void {
  const cols: Column[] = [
    { header: "table", align: "l" },
    { header: "lignes", align: "r" },
    { header: "uniques", align: "r" },
    { header: "dernière capture", align: "l" },
    { header: "", align: "l" },
  ];
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  let totLignes = 0;
  let totUniques = 0;
  const body = rows.map((r) => {
    totLignes += r.total;
    totUniques += r.uniques;
    return [r.table, num(r.total), num(r.uniques), fmtDate(r.last), magnitudeBar(r.total, maxTotal)];
  });
  renderTable(
    `VOLUMÉTRIE RAW  ·  saison ${saison}  (lignes capturées, append-only)`,
    cols,
    body,
    ["TOTAL", num(totLignes), num(totUniques), "", ""],
  );
}

function renderCoreVolume(saison: string, rows: CoreVolume[]): void {
  const cols: Column[] = [
    { header: "table", align: "l" },
    { header: "lignes", align: "r" },
    { header: "filtre", align: "l" },
    { header: "", align: "l" },
  ];
  const maxCount = Math.max(1, ...rows.map((r) => r.count));
  const body = rows.map((r) => [
    r.table,
    num(r.count),
    r.saisonFiltered ? c.cyan("saison") : c.gray("global"),
    magnitudeBar(r.count, maxCount),
  ]);
  renderTable("VOLUMÉTRIE CORE  ·  données normalisées", cols, body);
  out(
    c.dim(
      `  (« saison » = compté pour ${saison} ; « global » = table référentielle non filtrable par saison)`,
    ),
  );
}

function renderStorage(db: DbInfo | null): void {
  if (!db || db.tables.length === 0) return;
  const cols: Column[] = [
    { header: "table", align: "l" },
    { header: "taille", align: "r" },
    { header: "lignes", align: "r" },
    { header: "", align: "l" },
  ];
  const maxBytes = Math.max(1, ...db.tables.map((t) => t.bytes));
  const body = db.tables.map((t) => [
    `${c.dim(`${t.schema}.`)}${t.table}`,
    fmtBytes(t.bytes),
    num(t.rows),
    magnitudeBar(t.bytes, maxBytes),
  ]);
  renderTable(`STOCKAGE  ·  base ${fmtBytes(db.total)}  (top tables par taille)`, cols, body);
}

function renderIncidents(latestScrape: ScrapeRow[], latestEtl: EtlRow[]): void {
  const incidents: string[] = [];
  for (const r of latestScrape) {
    if ((r.status === "failed" || r.status === "partial") && r.error_message) {
      incidents.push(
        `  ${statusCell(r.status)} ${c.bold(`scrape ${r.scraper_name}`)} ${c.dim("—")} ${r.error_message.slice(0, 100)}`,
      );
    }
  }
  for (const r of latestEtl) {
    if ((r.status === "failed" || r.status === "partial") && r.error_message) {
      incidents.push(
        `  ${statusCell(r.status)} ${c.bold(`etl ${r.entity}`)} ${c.dim("—")} ${r.error_message.slice(0, 100)}`,
      );
    }
  }
  if (incidents.length === 0) return;
  out();
  out(c.gray("─".repeat(W)));
  out(c.bold(c.red(`INCIDENTS (${incidents.length})`)));
  out(c.gray("─".repeat(W)));
  for (const line of incidents) out(line);
}

function renderLegend(): void {
  out();
  out(
    c.dim("Légende  ") +
      `${c.green("✓ ok")}  ${c.yellow("~ partiel")}  ${c.red("✗ échec")}  ${c.cyan("… en cours")}` +
      c.dim("   ·   âge : ") +
      `${c.green("<1j")} ${c.dim("<3j")} ${c.yellow("<7j")} ${c.red(">7j")}`,
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      saison: { type: "string" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
    },
  });

  // Couleur : auto si TTY, sauf NO_COLOR / --no-color / --json (sortie machine).
  setColor(
    !values.json &&
      values["no-color"] !== true &&
      process.env.NO_COLOR == null &&
      Boolean(process.stdout.isTTY),
  );

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

  // --- Volumétrie + stockage (requêtes concurrentes) ---
  const coreDefs = await coreTables();
  const [rawVolRes, coreVolRes, db] = await Promise.all([
    Promise.all(RAW_TABLES.map((t) => rawVolume(t, saison))),
    Promise.all(coreDefs.map((d) => coreVolume(d.table, saison, d.hasSaison))),
    dbSize(),
  ]);
  const rawVol = rawVolRes.filter((r): r is RawVolume => r !== null);
  const coreVol = coreVolRes.filter((r): r is CoreVolume => r !== null);
  const coverage = buildCoverage(rawVol, coreVol);
  const coreTotalRows = coreVol.reduce((a, r) => a + r.count, 0);

  const latestScrapeArr = [...latestScrape.values()];
  const latestEtlArr = [...latestEtl.values()];

  // Entités « périmées » : dernière activité > 7j (alimente le verdict de santé).
  const staleCount = [...latestScrapeArr, ...latestEtlArr].filter((r) => {
    const d = r.finished_at ?? r.started_at;
    return Date.now() - d.getTime() > 7 * 86_400_000;
  }).length;

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
          sante: (() => {
            const h = healthVerdict(tally(latestScrapeArr), tally(latestEtlArr), staleCount);
            return { etat: h.label, staleCount };
          })(),
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
                  pagesPerSec: (() => {
                    const sec = durationSec(r.started_at, r.finished_at);
                    return sec && sec > 0 ? Number((r.pages_scraped / sec).toFixed(2)) : null;
                  })(),
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
          couverture: coverage.map((r) => ({
            entity: r.entity,
            rawUniques: r.rawUniques,
            coreCount: r.coreCount,
            coveragePct: r.rawUniques > 0 ? Math.round((r.coreCount / r.rawUniques) * 100) : null,
          })),
          volumetrieRaw: rawVol.map((r) => ({
            table: r.table,
            total: r.total,
            uniques: r.uniques,
            lastCapture: r.last?.toISOString() ?? null,
          })),
          volumetrieCore: coreVol,
          stockage: db
            ? {
                totalBytes: db.total,
                tables: db.tables.map((t) => ({
                  table: `${t.schema}.${t.table}`,
                  bytes: t.bytes,
                  rows: t.rows,
                })),
              }
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  renderHeader(
    saison,
    saisons,
    scrapeRes.rows,
    etlRes.rows,
    latestScrapeArr,
    latestEtlArr,
    db,
    coreTotalRows,
    staleCount,
  );
  renderScrape(latestScrape);
  renderEtl(latestEtl, etlProgress);
  renderCoverage(coverage);
  renderRawVolume(saison, rawVol);
  renderCoreVolume(saison, coreVol);
  renderStorage(db);
  renderIncidents(latestScrapeArr, latestEtlArr);
  renderLegend();
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
