// tests/etl/phases.etl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
}

async function seedCompetition(id_ffhb: string): Promise<void> {
  await query(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ($1, 'X', 'national', $2)
     ON CONFLICT (id_ffhb) DO NOTHING`,
    [id_ffhb, SAISON],
  );
}

async function insertRawPhase(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.phases (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runPhasesEtl", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.phases, core.competitions, core.etl_runs, core.etl_warnings RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setupSaison();
  });

  it("inserts a phase when competition FK resolves", async () => {
    await seedCompetition("28227");
    await insertRawPhase(
      {
        ext_phase_id: "96749",
        ext_competition_id: "28227",
        nom: "LIGUE BUTAGAZ ENERGIE",
        source_url: "https://x/",
      },
      "96749",
    );
    const report = await runPhasesEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    const row = await query(`SELECT * FROM core.phases WHERE id_ffhb = '96749'`);
    expect(row.rowCount).toBe(1);
  });

  it("warns and skips when competition FK does not resolve", async () => {
    await insertRawPhase(
      {
        ext_phase_id: "99999",
        ext_competition_id: "GHOST",
        nom: "Orphan",
        source_url: "https://x/",
      },
      "99999",
    );
    const report = await runPhasesEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
    const warns = await query(`SELECT * FROM core.etl_warnings WHERE entity = 'phases'`);
    expect(warns.rowCount).toBe(1);
  });

  it("is idempotent", async () => {
    await seedCompetition("28227");
    await insertRawPhase(
      {
        ext_phase_id: "96749",
        ext_competition_id: "28227",
        nom: "x",
        source_url: "https://x/",
      },
      "96749",
    );
    await runPhasesEtl(SAISON);
    await runPhasesEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.phases`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });
});
