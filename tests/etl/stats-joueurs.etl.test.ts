// tests/etl/stats-joueurs.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runStatsJoueursEtl } from "@/etl/stats-joueurs.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extPouleId: string, equipeNom: string): Promise<{
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
     VALUES ('E1', $1, $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [equipeNom, SAISON],
  );
  return { poule_id: poule.rows[0]!.id, equipe_id: equipe.rows[0]!.id };
}

async function insertRawStats(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','stats-joueurs',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.stats_joueurs (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runStatsJoueursEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.stats_joueurs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='stats-joueurs'`);
    await query(`TRUNCATE core.stats_joueurs, core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts stat with both FKs resolved (equipe match exact)", async () => {
    const { poule_id, equipe_id } = await seedHierarchy("PO1", "HANDBALL PLAN DE CUQUES");
    await insertRawStats(
      {
        ext_poule_id: "PO1",
        individu_id: "I1",
        nom: "ANTONISSEN",
        prenom: "NELE",
        equipe_libelle: "HANDBALL PLAN DE CUQUES",
        match_count: 25,
        total_buts: 195,
        total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);

    const row = await query<{
      poule_id: number; equipe_id: number | null;
      individu_id: string; total_buts: number;
      equipe_libelle: string;
    }>(`SELECT poule_id, equipe_id, individu_id, total_buts, equipe_libelle
        FROM core.stats_joueurs`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.poule_id).toBe(poule_id);
    expect(row.rows[0]!.equipe_id).toBe(equipe_id);
    expect(row.rows[0]!.total_buts).toBe(195);
    expect(row.rows[0]!.equipe_libelle).toBe("HANDBALL PLAN DE CUQUES");
  });

  it("warns and skips when poule FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQUIPE");
    await insertRawStats(
      {
        ext_poule_id: "GHOST_POULE",
        individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQUIPE",
        match_count: 0, total_buts: 0, total_arrets: 0,
        source_url: "https://x/",
      },
      "GHOST_POULE-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("inserts with equipe_id=NULL + warning when equipe_libelle does not match", async () => {
    const { poule_id } = await seedHierarchy("PO1", "EQUIPE_REELLE");
    await insertRawStats(
      {
        ext_poule_id: "PO1",
        individu_id: "I1",
        nom: "N", prenom: "P",
        equipe_libelle: "EQUIPE_INTROUVABLE",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(1);
    const row = await query<{ equipe_id: number | null; equipe_libelle: string }>(
      `SELECT equipe_id, equipe_libelle FROM core.stats_joueurs WHERE poule_id = $1`,
      [poule_id],
    );
    expect(row.rows[0]!.equipe_id).toBeNull();
    expect(row.rows[0]!.equipe_libelle).toBe("EQUIPE_INTROUVABLE");
  });

  it("rejects invalid payload (Zod fail)", async () => {
    await insertRawStats({ junk: true } as object, "BAD");
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run → 1 ligne par PK composite)", async () => {
    await seedHierarchy("PO1", "EQ");
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQ",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await runStatsJoueursEtl(SAISON);
    await runStatsJoueursEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.stats_joueurs`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  it("updates stats and capture_date on re-run when values change", async () => {
    await seedHierarchy("PO1", "EQ");
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQ",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await runStatsJoueursEtl(SAISON);
    const before = await query<{ total_buts: number; capture_date: Date }>(
      `SELECT total_buts, capture_date FROM core.stats_joueurs`,
    );

    await new Promise((r) => setTimeout(r, 50));

    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQ",
        match_count: 8, total_buts: 25, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await runStatsJoueursEtl(SAISON);
    const after = await query<{ total_buts: number; capture_date: Date }>(
      `SELECT total_buts, capture_date FROM core.stats_joueurs`,
    );
    expect(after.rows[0]!.total_buts).toBe(25);
    expect(after.rows[0]!.capture_date.getTime()).toBeGreaterThan(before.rows[0]!.capture_date.getTime());
  });

  it("inserts multiple joueurs for same poule (full ranking)", async () => {
    const { poule_id } = await seedHierarchy("PO1", "EQ");
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "A", prenom: "X", equipe_libelle: "EQ",
        match_count: 5, total_buts: 30, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I2",
        nom: "B", prenom: "Y", equipe_libelle: "EQ",
        match_count: 5, total_buts: 25, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I2",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(2);
    const all = await query<{ count: string }>(
      `SELECT count(*) FROM core.stats_joueurs WHERE poule_id = $1`,
      [poule_id],
    );
    expect(Number(all.rows[0]!.count)).toBe(2);
  });

  it("equipe match strict scoped by saison (no cross-saison match)", async () => {
    // Une équipe en saison différente avec même nom ne devrait pas matcher
    await query(
      `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
       VALUES ('2024-2025', '2024-07-01', '2025-06-30')
       ON CONFLICT DO NOTHING`,
    );
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ('OLD', 'EQUIPE_X', '2024-2025')`,
    );
    const { poule_id } = await seedHierarchy("PO1", "AUTRE");

    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQUIPE_X",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    // Match doit échouer car EQUIPE_X est sur saison 2024-2025, pas 2025-2026
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(1);
    const row = await query<{ equipe_id: number | null }>(
      `SELECT equipe_id FROM core.stats_joueurs WHERE poule_id = $1`,
      [poule_id],
    );
    expect(row.rows[0]!.equipe_id).toBeNull();
  });

  afterAll(async () => {
    await closePool();
  });
});
