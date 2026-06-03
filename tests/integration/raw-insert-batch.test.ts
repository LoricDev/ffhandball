// tests/integration/raw-insert-batch.test.ts
// Vérifie la sémantique de insertRawBatch (append-only, dédup sur (natural_key, saison,
// payload_hash)) et sa parité avec insertRaw. Nécessite une base Postgres migrée.
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { insertRaw, insertRawBatch, type RawRow } from "@/scrapers/shared/raw-insert.js";

const SAISON = "2025-2026";

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','matchs',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

function row(run_id: string, nk: string, payload: unknown): RawRow {
  return {
    scrape_run_id: run_id,
    source_url: `https://www.ffhandball.fr/x/${nk}`,
    source_site: "ffhandball.fr",
    natural_key: nk,
    payload,
    saison: SAISON,
    http_status: 200,
  };
}

async function countRaw(nk?: string): Promise<number> {
  const res = nk
    ? await query<{ c: string }>(`SELECT count(*) c FROM raw.matchs WHERE natural_key=$1`, [nk])
    : await query<{ c: string }>(`SELECT count(*) c FROM raw.matchs`);
  return Number(res.rows[0]!.c);
}

describe("insertRawBatch", () => {
  let run_id: string;

  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='matchs'`);
    run_id = await startRun();
  });

  it("inserts all new rows and reports counts", async () => {
    const rows = [
      row(run_id, "M1", { v: 1 }),
      row(run_id, "M2", { v: 1 }),
      row(run_id, "M3", { v: 1 }),
    ];
    const res = await insertRawBatch("matchs", rows);
    expect(res).toEqual({ inserted: 3, duplicates: 0 });
    expect(await countRaw()).toBe(3);
  });

  it("is idempotent: re-running the same batch inserts nothing", async () => {
    const rows = [row(run_id, "M1", { v: 1 }), row(run_id, "M2", { v: 1 })];
    await insertRawBatch("matchs", rows);
    const res = await insertRawBatch("matchs", rows);
    expect(res).toEqual({ inserted: 0, duplicates: 2 });
    expect(await countRaw()).toBe(2);
  });

  it("appends a new row when the payload changes (history kept)", async () => {
    await insertRawBatch("matchs", [row(run_id, "M1", { score: null })]);
    const res = await insertRawBatch("matchs", [row(run_id, "M1", { score: "30-28" })]);
    expect(res.inserted).toBe(1);
    expect(await countRaw("M1")).toBe(2); // deux versions du même match
  });

  it("dedups identical (natural_key, payload) within a single batch", async () => {
    const rows = [
      row(run_id, "M1", { v: 1 }),
      row(run_id, "M1", { v: 1 }), // doublon intra-lot exact
      row(run_id, "M2", { v: 1 }),
    ];
    const res = await insertRawBatch("matchs", rows);
    expect(res.inserted).toBe(2);
    expect(await countRaw("M1")).toBe(1);
  });

  it("keeps distinct payloads for the same natural_key within a batch", async () => {
    const rows = [
      row(run_id, "M1", { v: 1 }),
      row(run_id, "M1", { v: 2 }), // même clé, payload différent → 2 versions
    ];
    const res = await insertRawBatch("matchs", rows);
    expect(res.inserted).toBe(2);
    expect(await countRaw("M1")).toBe(2);
  });

  it("matches insertRaw dedup semantics (batch skips what insertRaw already wrote)", async () => {
    await insertRaw("matchs", row(run_id, "M1", { v: 1 }));
    const res = await insertRawBatch("matchs", [
      row(run_id, "M1", { v: 1 }), // déjà écrit par insertRaw → dup
      row(run_id, "M2", { v: 1 }), // nouveau
    ]);
    expect(res).toEqual({ inserted: 1, duplicates: 1 });
    expect(await countRaw()).toBe(2);
  });

  it("returns zero counts on empty input without touching the DB", async () => {
    const res = await insertRawBatch("matchs", []);
    expect(res).toEqual({ inserted: 0, duplicates: 0 });
    expect(await countRaw()).toBe(0);
  });
});
