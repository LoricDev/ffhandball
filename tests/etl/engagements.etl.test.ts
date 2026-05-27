// tests/etl/engagements.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runEngagementsEtl } from "@/etl/engagements.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extPouleId: string, extEquipeId: string): Promise<{ equipe_id: number; poule_id: number }> {
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1','C','national',$1)
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const phase = await query<{ id: number }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ('PH1', $1, 'P', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const poule = await query<{ id: number }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
     VALUES ($1, $2, 'Poule', $3)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [extPouleId, phase.rows[0]!.id, SAISON],
  );
  const equipe = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ($1, 'Equipe', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [extEquipeId, SAISON],
  );
  return { equipe_id: equipe.rows[0]!.id, poule_id: poule.rows[0]!.id };
}

async function insertRawEngagement(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.engagements (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runEngagementsEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await query(`TRUNCATE core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts engagement when both FKs resolve", async () => {
    const { equipe_id, poule_id } = await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "EQ1", ext_poule_id: "EPO1", source_url: "https://x/" },
      "EQ1-EPO1",
    );
    const report = await runEngagementsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);
    const row = await query<{ equipe_id: number; poule_id: number }>(
      `SELECT equipe_id, poule_id FROM core.engagements`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.equipe_id).toBe(equipe_id);
    expect(row.rows[0]!.poule_id).toBe(poule_id);
  });

  it("warns and skips when equipe FK does not resolve", async () => {
    await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "GHOST", ext_poule_id: "EPO1", source_url: "https://x/" },
      "GHOST-EPO1",
    );
    const report = await runEngagementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips when poule FK does not resolve", async () => {
    await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "EQ1", ext_poule_id: "GHOST", source_url: "https://x/" },
      "EQ1-GHOST",
    );
    const report = await runEngagementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("is idempotent via ON CONFLICT on composite PK", async () => {
    await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "EQ1", ext_poule_id: "EPO1", source_url: "https://x/" },
      "EQ1-EPO1",
    );
    await runEngagementsEtl(SAISON);
    await runEngagementsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.engagements`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  afterAll(async () => {
    await closePool();
  });
});
