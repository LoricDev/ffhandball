// src/etl/shared/iterate-raw-batched.ts
import { query } from "@/db/client.js";

/** Ligne brute minimale lue depuis une table raw.* (forme commune à tous les ETL). */
export interface RawRow {
  id: number;
  natural_key: string;
  payload: unknown;
}

/**
 * Tables raw.* itérables par lots. Liste blanche : un nom de table ne peut pas être passé
 * en paramètre SQL, il est donc interpolé. On restreint aux littéraux connus (vérifié aussi
 * à l'exécution ci-dessous) pour qu'aucune valeur arbitraire ne puisse atteindre le SQL.
 */
export type RawTable =
  | "raw.feuilles_match"
  | "raw.matchs"
  | "raw.classements"
  | "raw.stats_joueurs";

const ALLOWED_TABLES: readonly RawTable[] = [
  "raw.feuilles_match",
  "raw.matchs",
  "raw.classements",
  "raw.stats_joueurs",
];

const DEFAULT_BATCH_SIZE = 200;

/**
 * Itère les lignes d'une table raw.* pour une saison, PAR LOTS (keyset pagination sur
 * natural_key), sans jamais tout charger en mémoire — charger tout d'un coup faisait
 * exploser la heap Node sur les gros volumes (payloads JSONB × milliers de lignes → OOM).
 *
 * DISTINCT ON (natural_key) conserve la dernière version scrapée (scraped_at DESC) de chaque
 * clé. Le curseur natural_key est strictement croissant → ni doublon, ni saut, ni boucle
 * infinie. Chaque lot est libéré (GC) avant le suivant → mémoire bornée quel que soit le total.
 */
/**
 * Options de filtrage. `since` ne retient que les clés dont la dernière capture est
 * postérieure ou égale au timestamp donné (mode ETL incrémental : ne retraiter que le
 * delta du dernier scrape). La sémantique DISTINCT ON reste correcte — pour chaque
 * natural_key, on ne considère que ses versions >= since, donc la plus récente d'entre
 * elles, c.-à-d. la version courante de la clé.
 */
export interface IterateOptions {
  batchSize?: number;
  since?: Date;
  /** Ne retenir que ces poules (payload.ext_poule_id) : classements, stats-joueurs, matchs. */
  pouleIds?: string[];
  /** Ne retenir que ces clés naturelles (ex. codes FdM d'un club pour raw.feuilles_match). */
  naturalKeys?: string[];
}

/** Filtres communs à l'itération et au comptage ; `params` reçoit les valeurs, les index suivent `params.length`. */
function buildFilters(opts: Pick<IterateOptions, "since" | "pouleIds" | "naturalKeys">, params: unknown[]): string {
  let sql = "";
  if (opts.since) {
    params.push(opts.since);
    sql += ` AND scraped_at >= $${params.length}`;
  }
  if (opts.pouleIds) {
    params.push(opts.pouleIds);
    sql += ` AND payload->>'ext_poule_id' = ANY($${params.length}::text[])`;
  }
  if (opts.naturalKeys) {
    params.push(opts.naturalKeys);
    sql += ` AND natural_key = ANY($${params.length}::text[])`;
  }
  return sql;
}

/** Nombre de clés distinctes qu'`iterateRawBatched` va produire (pour une barre de progression). */
export async function countRawDistinct(
  table: RawTable,
  saison: string,
  filters?: Date | Pick<IterateOptions, "since" | "pouleIds" | "naturalKeys">,
): Promise<number> {
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`countRawDistinct: table non autorisée: ${String(table)}`);
  }
  const opts = filters instanceof Date ? { since: filters } : (filters ?? {});
  const params: unknown[] = [saison];
  const where = buildFilters(opts, params);
  const r = await query<{ n: string }>(
    `SELECT count(DISTINCT natural_key)::bigint AS n FROM ${table} WHERE saison = $1${where}`,
    params,
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function* iterateRawBatched(
  table: RawTable,
  saison: string,
  opts: IterateOptions = {},
): AsyncGenerator<RawRow> {
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`iterateRawBatched: table non autorisée: ${String(table)}`);
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  let lastNaturalKey = "";
  for (;;) {
    const params: unknown[] = [saison, lastNaturalKey, batchSize];
    const where = buildFilters(opts, params);
    const res = await query<RawRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM ${table}
        WHERE saison = $1 AND natural_key > $2${where}
        ORDER BY natural_key, scraped_at DESC
        LIMIT $3`,
      params,
    );
    if (res.rows.length === 0) return;

    for (const row of res.rows) yield row;

    lastNaturalKey = res.rows[res.rows.length - 1]!.natural_key;
    if (res.rows.length < batchSize) return;
  }
}
