import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { query, closePool } from "@/db/client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runSallesEtl } from "@/etl/salles.etl.js";

const SAISON = "2025-2026";
const SALLE_IDS = ["test-salle-a", "test-salle-b", "test-salle-baddept"];

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM core.etl_warnings WHERE natural_key = ANY($1::text[])`,
    [SALLE_IDS],
  );
  await query(
    `DELETE FROM core.etl_rejets WHERE natural_key = ANY($1::text[])`,
    [SALLE_IDS],
  );
  await query(`DELETE FROM core.salles WHERE id_ffhb = ANY($1::text[])`, [SALLE_IDS]);
  await query(
    `DELETE FROM raw.salles WHERE natural_key = ANY($1::text[]) AND saison = $2`,
    [SALLE_IDS, SAISON],
  );
  await query(
    `DELETE FROM raw.scrape_runs
       WHERE scraper_name = 'club-details' AND saison = $1
         AND id NOT IN (SELECT scrape_run_id FROM raw.salles)
         AND id NOT IN (SELECT scrape_run_id FROM raw.clubs)`,
    [SAISON],
  );
}

async function seedRawSalle(
  scrape_run_id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await insertRaw("salles", {
    scrape_run_id,
    source_url: "https://monclub.ffhandball.fr/clubs/test/",
    source_site: "monclub.ffhandball.fr",
    natural_key: payload.id_ffhb as string,
    payload,
    saison: SAISON,
    http_status: 200,
  });
}

describe("salles ETL — cas nominal", () => {
  beforeEach(cleanup);

  it("insère une salle valide en core.salles", async () => {
    const run = await startScrapeRun({
      source_site: "monclub.ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await seedRawSalle(run.id, {
      id_ffhb: "test-salle-a",
      nom: "Gymnase Léo Lagrange",
      adresse: "12 rue du Stade",
      code_postal: "75001",
      ville: "Paris",
      departement_code: "75",
      source_url: "https://monclub.ffhandball.fr/clubs/test/",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const report = await runSallesEtl(SAISON);
    expect(report.rows_read).toBeGreaterThanOrEqual(1);
    expect(report.rows_validated).toBeGreaterThanOrEqual(1);
    expect(report.rows_inserted).toBeGreaterThanOrEqual(1);

    const r = await query<{ nom: string; ville: string; departement_id: number | null }>(
      `SELECT nom, ville, departement_id FROM core.salles WHERE id_ffhb = $1`,
      ["test-salle-a"],
    );
    expect(r.rows[0]!.nom).toBe("Gymnase Léo Lagrange");
    expect(r.rows[0]!.ville).toBe("Paris");
    expect(r.rows[0]!.departement_id).not.toBeNull();
  });
});

describe("salles ETL — cas dégradés", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("rejette un payload Zod-invalide (nom manquant)", async () => {
    const run = await startScrapeRun({
      source_site: "monclub.ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await seedRawSalle(run.id, {
      id_ffhb: "test-salle-b",
      // nom manquant exprès
      source_url: "https://monclub.ffhandball.fr/clubs/test/",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const report = await runSallesEtl(SAISON);
    expect(report.rows_rejected).toBeGreaterThanOrEqual(1);

    const rej = await query<{ reason: string }>(
      `SELECT reason FROM core.etl_rejets WHERE natural_key = $1 ORDER BY id DESC LIMIT 1`,
      ["test-salle-b"],
    );
    expect(rej.rows[0]!.reason).toContain("nom");
  });

  it("loggue un warning quand le département est introuvable", async () => {
    const run = await startScrapeRun({
      source_site: "monclub.ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await seedRawSalle(run.id, {
      id_ffhb: "test-salle-baddept",
      nom: "Salle Inconnue",
      departement_code: "999",
      source_url: "https://monclub.ffhandball.fr/clubs/test/",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const report = await runSallesEtl(SAISON);
    expect(report.warnings_count).toBeGreaterThanOrEqual(1);
    expect(report.rows_inserted).toBeGreaterThanOrEqual(1);

    const r = await query<{ departement_id: number | null }>(
      `SELECT departement_id FROM core.salles WHERE id_ffhb = $1`,
      ["test-salle-baddept"],
    );
    expect(r.rows[0]!.departement_id).toBeNull();
  });

  it("est idempotent — second run ne réinsère rien", async () => {
    const run = await startScrapeRun({
      source_site: "monclub.ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await seedRawSalle(run.id, {
      id_ffhb: "test-salle-a",
      nom: "Gymnase Léo Lagrange",
      code_postal: "75001",
      ville: "Paris",
      departement_code: "75",
      source_url: "https://monclub.ffhandball.fr/clubs/test/",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const r1 = await runSallesEtl(SAISON);
    expect(r1.rows_inserted).toBe(1);

    const r2 = await runSallesEtl(SAISON);
    expect(r2.rows_read).toBe(1);
    expect(r2.rows_inserted).toBe(0);
    expect(r2.rows_updated).toBe(0);
    expect(r2.rows_noop).toBe(1);
  });
});
