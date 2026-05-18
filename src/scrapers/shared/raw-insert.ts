import { createHash } from "node:crypto";
import { query } from "@/db/client.js";

export interface RawRow {
  scrape_run_id: string;
  source_url: string;
  source_site: string;
  natural_key: string;
  payload: unknown;
  saison: string;
  http_status: number;
}

export function hashPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  return createHash("sha256").update(json).digest("hex");
}

export async function insertRaw(
  table: string,
  row: RawRow,
): Promise<{ id: number; inserted: boolean }> {
  const payload_hash = hashPayload(row.payload);

  const dup = await query<{ id: number }>(
    `SELECT id FROM raw.${table}
     WHERE natural_key = $1 AND saison = $2 AND payload_hash = $3
     LIMIT 1`,
    [row.natural_key, row.saison, payload_hash],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    return { id: dup.rows[0]!.id, inserted: false };
  }

  const res = await query<{ id: number }>(
    `INSERT INTO raw.${table}
       (scrape_run_id, source_url, source_site, natural_key,
        payload, payload_hash, saison, http_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      row.scrape_run_id,
      row.source_url,
      row.source_site,
      row.natural_key,
      row.payload,
      payload_hash,
      row.saison,
      row.http_status,
    ],
  );
  return { id: res.rows[0]!.id, inserted: true };
}
