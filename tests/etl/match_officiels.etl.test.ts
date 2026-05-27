// tests/etl/match_officiels.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runMatchOfficielsEtl } from "@/etl/match_officiels.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extMatchId: string): Promise<{ match_id: number }> {
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
     VALUES ('PO1', $1, 'Poule', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ('EDOM', 'Dom', $1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ('EEXT', 'Ext', $1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const match = await query<{ id: number }>(
    `INSERT INTO core.matchs (
       id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure
     ) VALUES ($1, $2, $3, $4, '2025-09-03T20:00:00+02:00') RETURNING id`,
    [extMatchId, poule.rows[0]!.id, eqDom.rows[0]!.id, eqExt.rows[0]!.id],
  );
  return { match_id: match.rows[0]!.id };
}

async function seedArbitre(idFfhb: string, nom: string): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO core.arbitres (id_ffhb, nom, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [idFfhb, nom],
  );
  return r.rows[0]!.id;
}

async function insertRawMatch(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','matchs',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.matchs (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runMatchOfficielsEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='matchs'`);
    await query(`TRUNCATE core.match_officiels, core.matchs, core.arbitres, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts 2 lignes (arbitre_1, arbitre_2) when both arbitres present", async () => {
    const { match_id } = await seedHierarchy("M1");
    const a1 = await seedArbitre("A1", "CHAMI");
    const a2 = await seedArbitre("A2", "MILI");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre2_id: "A2" },
      "M1",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(2);
    expect(report.warnings_count).toBe(0);
    const r = await query<{ role: string; arbitre_id: number }>(
      `SELECT role, arbitre_id FROM core.match_officiels WHERE match_id = $1 ORDER BY role`,
      [match_id],
    );
    expect(r.rowCount).toBe(2);
    expect(r.rows[0]!.role).toBe("arbitre_1");
    expect(r.rows[0]!.arbitre_id).toBe(a1);
    expect(r.rows[1]!.role).toBe("arbitre_2");
    expect(r.rows[1]!.arbitre_id).toBe(a2);
  });

  it("inserts only arbitre_1 when arbitre2_id is absent", async () => {
    const { match_id } = await seedHierarchy("M1");
    await seedArbitre("A1", "CHAMI");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1" },
      "M1",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    const r = await query<{ role: string }>(
      `SELECT role FROM core.match_officiels WHERE match_id = $1`,
      [match_id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.role).toBe("arbitre_1");
  });

  it("warns and skips when match FK not resolved", async () => {
    await seedArbitre("A1", "CHAMI");
    await insertRawMatch(
      { ext_rencontre_id: "GHOST_MATCH", arbitre1_id: "A1" },
      "GHOST_MATCH",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips one arbitre when its FK not resolved, inserts the other", async () => {
    await seedHierarchy("M1");
    await seedArbitre("A1", "CHAMI");
    // A2 not seeded → FK arbitre2 will fail
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre2_id: "GHOST_ARBITRE" },
      "M1",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);  // arbitre_1 inséré, arbitre_2 skip
    expect(report.warnings_count).toBe(1);
  });

  it("is idempotent via ON CONFLICT DO NOTHING on PK (match, arbitre, role)", async () => {
    await seedHierarchy("M1");
    await seedArbitre("A1", "CHAMI");
    await seedArbitre("A2", "MILI");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre2_id: "A2" },
      "M1",
    );
    await runMatchOfficielsEtl(SAISON);
    await runMatchOfficielsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`);
    expect(Number(r.rows[0]!.count)).toBe(2);
  });

  afterAll(async () => {
    await closePool();
  });
});
