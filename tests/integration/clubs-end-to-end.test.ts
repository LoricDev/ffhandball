import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, closePool } from "@/db/client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/ffhandball-clubs-listing.html", import.meta.url),
);
const SAISON = "2025-2026";
const TEST_IDS = ["6275001", "6275002"];

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM core.etl_warnings WHERE natural_key = ANY($1::text[])`,
    [TEST_IDS],
  );
  await query(
    `DELETE FROM core.etl_rejets WHERE natural_key = ANY($1::text[])`,
    [TEST_IDS],
  );
  await query(`DELETE FROM core.clubs WHERE id_ffhb = ANY($1::text[])`, [TEST_IDS]);
  await query(
    `DELETE FROM raw.clubs WHERE natural_key = ANY($1::text[]) AND saison = $2`,
    [TEST_IDS, SAISON],
  );
  await query(
    `DELETE FROM raw.scrape_runs WHERE scraper_name = 'clubs' AND saison = $1
       AND id NOT IN (SELECT scrape_run_id FROM raw.clubs)`,
    [SAISON],
  );
}

describe("clubs end-to-end", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("scrape (fixture) → raw → ETL → core, idempotent", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const clubs = parseClubsListing(html, "https://www.ffhandball.fr/clubs");
    expect(clubs).toHaveLength(2);

    const run = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "clubs",
      saison: SAISON,
    });
    for (const c of clubs) {
      await insertRaw("clubs", {
        scrape_run_id: run.id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.id_ffhb,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    await run.finishSuccess();

    const r1 = await runClubsEtl(SAISON);
    expect(r1.rows_read).toBe(2);
    expect(r1.rows_validated).toBe(2);
    expect(r1.rows_rejected).toBe(0);
    expect(r1.rows_inserted).toBe(2);
    expect(r1.rows_updated).toBe(0);

    const core = await query<{ id_ffhb: string; nom: string }>(
      `SELECT id_ffhb, nom FROM core.clubs WHERE id_ffhb = ANY($1::text[]) ORDER BY id_ffhb`,
      [TEST_IDS],
    );
    expect(core.rows.map((r) => r.id_ffhb)).toEqual(["6275001", "6275002"]);
    // titleCaseFr lowercases every word then caps the first letter:
    // "HBC" → capFirst("HBC") = "Hbc", "Trifouilly" stays, "sur" is a particle but
    // it appears after a hyphen so it gets capFirst → "Sur", "Mer" → "Mer".
    // Net result: "Hbc Trifouilly-Sur-Mer". This documents the current behavior of
    // titleCaseFr for all-uppercase acronyms — intentionally not changed here.
    expect(core.rows[0]!.nom).toBe("Hbc Trifouilly-Sur-Mer");

    // Round 2 — replay should be idempotent (no inserts, no updates because data unchanged).
    // insertRaw deduplicates by payload_hash, so no new raw rows are written for run2.
    // runClubsEtl reads the same 2 rows (DISTINCT ON natural_key), upserts with no diff → noop.
    const run2 = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "clubs",
      saison: SAISON,
    });
    for (const c of clubs) {
      await insertRaw("clubs", {
        scrape_run_id: run2.id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.id_ffhb,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    await run2.finishSuccess();

    const r2 = await runClubsEtl(SAISON);
    expect(r2.rows_read).toBe(2);
    expect(r2.rows_inserted).toBe(0);
    expect(r2.rows_updated).toBe(0);
    expect(r2.rows_noop).toBe(2);
  });
});
