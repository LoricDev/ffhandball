// tests/etl/poules.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
}

async function seedCompetitionAndPhase(extPhaseId: string): Promise<void> {
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1', 'C', 'national', $1)
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ($1, $2, 'P', $3)
     ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
    [extPhaseId, comp.rows[0]!.id, SAISON],
  );
}

async function insertRawPoule(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.poules (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runPoulesEtl", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setupSaison();
  });

  it("inserts a poule when phase FK resolves", async () => {
    await seedCompetitionAndPhase("PH1");
    await insertRawPoule(
      { ext_poule_id: "PO1", ext_phase_id: "PH1", nom: "POULE UNIQUE", source_url: "https://x/" },
      "PO1",
    );
    const report = await runPoulesEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    const row = await query(`SELECT * FROM core.poules WHERE id_ffhb = 'PO1'`);
    expect(row.rowCount).toBe(1);
  });

  it("warns and skips when phase FK does not resolve", async () => {
    await insertRawPoule(
      { ext_poule_id: "X", ext_phase_id: "GHOST", nom: "x", source_url: "https://x/" },
      "X",
    );
    const report = await runPoulesEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("is idempotent", async () => {
    await seedCompetitionAndPhase("PH1");
    await insertRawPoule(
      { ext_poule_id: "PO1", ext_phase_id: "PH1", nom: "x", source_url: "https://x/" },
      "PO1",
    );
    await runPoulesEtl(SAISON);
    await runPoulesEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.poules`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  afterAll(async () => {
    await closePool();
  });
});
