import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, closePool } from "@/db/client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubDetail } from "@/scrapers/ffhandball/club-details.scraper.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";
import { runSallesEtl } from "@/etl/salles.etl.js";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/ffhandball-club-detail-complet.html", import.meta.url),
);
const SAISON = "2025-2026";
const SOURCE_URL = "https://monclub.ffhandball.fr/clubs/handball-club-de-vihiers/";

// IDs come from the parsed fixture — compute lazily, don't hardcode the slug
let clubId: string;
let salleId: string;

async function cleanup(): Promise<void> {
  const naturalKeys = [clubId, salleId].filter(Boolean);
  if (naturalKeys.length > 0) {
    await query(
      `DELETE FROM core.etl_warnings WHERE natural_key = ANY($1::text[])`,
      [naturalKeys],
    );
    await query(
      `DELETE FROM core.etl_rejets WHERE natural_key = ANY($1::text[])`,
      [naturalKeys],
    );
  }
  if (clubId) {
    // Reset FK before deleting salles
    await query(
      `UPDATE core.clubs SET salle_principale_id = NULL WHERE id_ffhb = $1`,
      [clubId],
    );
  }
  if (salleId) {
    await query(`DELETE FROM core.salles WHERE id_ffhb = $1`, [salleId]);
    await query(
      `DELETE FROM raw.salles WHERE natural_key = $1 AND saison = $2`,
      [salleId, SAISON],
    );
  }
  if (clubId) {
    await query(`DELETE FROM core.clubs WHERE id_ffhb = $1`, [clubId]);
    await query(
      `DELETE FROM raw.clubs WHERE natural_key = $1 AND saison = $2`,
      [clubId, SAISON],
    );
  }
  await query(
    `DELETE FROM raw.scrape_runs
       WHERE scraper_name = 'club-details' AND saison = $1
         AND id NOT IN (SELECT scrape_run_id FROM raw.clubs)
         AND id NOT IN (SELECT scrape_run_id FROM raw.salles)`,
    [SAISON],
  );
}

describe("club-details end-to-end", () => {
  beforeAll(async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const parsed = parseClubDetail(html, SOURCE_URL);
    if (!parsed || !parsed.salle) {
      throw new Error("fixture complet must yield a club + salle");
    }
    clubId = parsed.club.id_ffhb;
    salleId = parsed.salle.id_ffhb;
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("scrape (fixture) → raw → salles ETL → clubs ETL → salle_principale_id resolved", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const parsed = parseClubDetail(html, SOURCE_URL);
    expect(parsed).not.toBeNull();
    expect(parsed!.salle).not.toBeNull();

    // 1. Emulate scrape: write raw rows
    const run = await startScrapeRun({
      source_site: "monclub.ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await insertRaw("clubs", {
      scrape_run_id: run.id,
      source_url: SOURCE_URL,
      source_site: "monclub.ffhandball.fr",
      natural_key: parsed!.club.id_ffhb,
      payload: parsed!.club,
      saison: SAISON,
      http_status: 200,
    });
    await insertRaw("salles", {
      scrape_run_id: run.id,
      source_url: SOURCE_URL,
      source_site: "monclub.ffhandball.fr",
      natural_key: parsed!.salle!.id_ffhb,
      payload: parsed!.salle!,
      saison: SAISON,
      http_status: 200,
    });
    await run.finishSuccess();

    // 2. ETL salles first (so FK can resolve)
    const rs = await runSallesEtl(SAISON);
    expect(rs.rows_inserted).toBeGreaterThanOrEqual(1);

    // 3. ETL clubs after — resolves salle_principale_id
    const rc = await runClubsEtl(SAISON);
    expect(rc.rows_validated).toBeGreaterThanOrEqual(1);
    expect(rc.warnings_count).toBe(0); // no FK warnings because salle exists

    // 4. Verify the join
    const r = await query<{
      salle_principale_id: number | null;
      telephone: string | null;
      effectif_estime: number | null;
    }>(
      `SELECT salle_principale_id, telephone, effectif_estime
         FROM core.clubs WHERE id_ffhb = $1`,
      [clubId],
    );
    expect(r.rows[0]!.salle_principale_id).not.toBeNull();
    // From fixture: tel_club="0698704077"
    expect(r.rows[0]!.telephone).toBe("0698704077");
    // 25+16+30+20 = 91 (verified in T1 inventory and T5 tests)
    expect(r.rows[0]!.effectif_estime).toBe(91);
  });

  it("second pass is idempotent — no new inserts, no updates", async () => {
    // Skip the scrape step (raw rows are still there from the previous test in
    // the same describe; both tests share the same beforeAll). Re-running the
    // two ETLs should leave the DB exactly as-is.
    const rs2 = await runSallesEtl(SAISON);
    expect(rs2.rows_read).toBe(1);
    expect(rs2.rows_inserted).toBe(0);
    expect(rs2.rows_updated).toBe(0);
    expect(rs2.rows_noop).toBe(1);

    const rc2 = await runClubsEtl(SAISON);
    expect(rc2.rows_read).toBe(1);
    expect(rc2.rows_inserted).toBe(0);
    expect(rc2.rows_updated).toBe(0);
    expect(rc2.rows_noop).toBe(1);
  });
});
