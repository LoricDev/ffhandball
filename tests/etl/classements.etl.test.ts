// tests/etl/classements.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runClassementsEtl } from "@/etl/classements.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extPouleId: string, extEquipeId: string): Promise<{
  poule_id: number; equipe_id: number;
}> {
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
  return { poule_id: poule.rows[0]!.id, equipe_id: equipe.rows[0]!.id };
}

async function insertRawClassement(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','classements',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.classements (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runClassementsEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.classements`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='classements'`);
    await query(`TRUNCATE core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts classement with both FKs resolved", async () => {
    const { poule_id, equipe_id } = await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1",
        ext_poule_id: "PO1",
        ext_equipe_id: "EQ1",
        position: 1,
        points: 73,
        joues: 25,
        gagnes: 24,
        nuls: 0,
        perdus: 1,
        buts_pour: 849,
        buts_contre: 603,
        dernieres_rencontres: "-1;1;1;1;1",
        source_url: "https://x/",
      },
      "C1",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);

    const row = await query<{
      poule_id: number; equipe_id: number; position: number; points: number;
      joues: number; buts_pour: number; difference: number;
      id_ffhb: string | null; dernieres_rencontres: string | null;
    }>(`SELECT poule_id, equipe_id, position, points, joues, buts_pour, difference,
                  id_ffhb, dernieres_rencontres
        FROM core.classements WHERE id_ffhb = 'C1'`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.poule_id).toBe(poule_id);
    expect(row.rows[0]!.equipe_id).toBe(equipe_id);
    expect(row.rows[0]!.position).toBe(1);
    expect(row.rows[0]!.points).toBe(73);
    expect(row.rows[0]!.difference).toBe(246); // GENERATED 849 - 603
    expect(row.rows[0]!.id_ffhb).toBe("C1");
    expect(row.rows[0]!.dernieres_rencontres).toBe("-1;1;1;1;1");
  });

  it("warns and skips when poule FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C2",
        ext_poule_id: "GHOST_POULE",
        ext_equipe_id: "EQ1",
        position: 1, points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
        buts_pour: 0, buts_contre: 0,
        source_url: "https://x/",
      },
      "C2",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips when equipe FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C3",
        ext_poule_id: "PO1",
        ext_equipe_id: "GHOST_EQUIPE",
        position: 1, points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
        buts_pour: 0, buts_contre: 0,
        source_url: "https://x/",
      },
      "C3",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("rejects invalid payload (Zod fail)", async () => {
    await insertRawClassement({ junk: true } as object, "BAD");
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run → 1 ligne par PK composite)", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1",
        ext_poule_id: "PO1",
        ext_equipe_id: "EQ1",
        position: 1, points: 73, joues: 25, gagnes: 24, nuls: 0, perdus: 1,
        buts_pour: 849, buts_contre: 603,
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    await runClassementsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.classements`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  it("updates stats and capture_date on re-run when classement changes", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 5, points: 10, joues: 5, gagnes: 3, nuls: 1, perdus: 1,
        buts_pour: 100, buts_contre: 80,
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    const before = await query<{ position: number; points: number; capture_date: Date }>(
      `SELECT position, points, capture_date FROM core.classements WHERE id_ffhb='C1'`,
    );

    await new Promise((r) => setTimeout(r, 50));

    // Nouvelle journée : meilleur classement
    await insertRawClassement(
      {
        ext_classement_id: "C1", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 2, points: 13, joues: 6, gagnes: 4, nuls: 1, perdus: 1,
        buts_pour: 130, buts_contre: 100,
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    const after = await query<{ position: number; points: number; capture_date: Date }>(
      `SELECT position, points, capture_date FROM core.classements WHERE id_ffhb='C1'`,
    );
    expect(after.rows[0]!.position).toBe(2);
    expect(after.rows[0]!.points).toBe(13);
    expect(after.rows[0]!.capture_date.getTime()).toBeGreaterThan(before.rows[0]!.capture_date.getTime());
  });

  it("inserts multiple classements for the same poule (full ranking)", async () => {
    const { poule_id } = await seedHierarchy("PO1", "EQ1");
    // Seed a 2nd equipe
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ('EQ2', 'E2', $1)
       ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
      [SAISON],
    );
    await insertRawClassement(
      {
        ext_classement_id: "CA", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 1, points: 10, joues: 5, gagnes: 3, nuls: 1, perdus: 1,
        buts_pour: 100, buts_contre: 80,
        source_url: "https://x/",
      },
      "CA",
    );
    await insertRawClassement(
      {
        ext_classement_id: "CB", ext_poule_id: "PO1", ext_equipe_id: "EQ2",
        position: 2, points: 8, joues: 5, gagnes: 2, nuls: 2, perdus: 1,
        buts_pour: 90, buts_contre: 85,
        source_url: "https://x/",
      },
      "CB",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(2);
    const all = await query<{ count: string }>(
      `SELECT count(*) FROM core.classements WHERE poule_id = $1`,
      [poule_id],
    );
    expect(Number(all.rows[0]!.count)).toBe(2);
  });

  it("stores dernieres_rencontres as raw string", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 1, points: 73, joues: 25, gagnes: 24, nuls: 0, perdus: 1,
        buts_pour: 849, buts_contre: 603,
        dernieres_rencontres: "-1;1;0;1;1",
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    const r = await query<{ dernieres_rencontres: string | null }>(
      `SELECT dernieres_rencontres FROM core.classements WHERE id_ffhb='C1'`,
    );
    expect(r.rows[0]!.dernieres_rencontres).toBe("-1;1;0;1;1");
  });

  afterAll(async () => {
    await closePool();
  });
});
