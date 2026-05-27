// tests/etl/matchs.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runMatchsEtl } from "@/etl/matchs.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extPouleId: string, extEquipeDom: string, extEquipeExt: string): Promise<{
  poule_id: number; equipe_dom_id: number; equipe_ext_id: number;
}> {
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1', 'C', 'national', $1)
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
  const equipeDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ($1, 'Dom', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [extEquipeDom, SAISON],
  );
  const equipeExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ($1, 'Ext', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [extEquipeExt, SAISON],
  );
  return {
    poule_id: poule.rows[0]!.id,
    equipe_dom_id: equipeDom.rows[0]!.id,
    equipe_ext_id: equipeExt.rows[0]!.id,
  };
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

describe("runMatchsEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name IN ('competitions','matchs')`);
    await query(`TRUNCATE core.matchs, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts match with all FKs resolved (statut=joue when scores present)", async () => {
    const { poule_id, equipe_dom_id, equipe_ext_id } = await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R1",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2025-09-03T20:00:00+02:00",
        score_dom: 28,
        score_ext: 25,
        score_mt_dom: 14,
        score_mt_ext: 12,
        journee: 1,
        equipement_id: "2348",
        source_url: "https://x/",
      },
      "R1",
    );
    const report = await runMatchsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);

    const row = await query<{
      poule_id: number; equipe_dom_id: number; equipe_ext_id: number;
      statut: string; score_dom: number | null; score_ext: number | null;
      equipement_id: string | null; salle_id: number | null; heure_estimee: boolean;
    }>(`SELECT poule_id, equipe_dom_id, equipe_ext_id, statut, score_dom, score_ext,
               equipement_id, salle_id, heure_estimee
        FROM core.matchs WHERE id_ffhb_match = 'R1'`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.poule_id).toBe(poule_id);
    expect(row.rows[0]!.equipe_dom_id).toBe(equipe_dom_id);
    expect(row.rows[0]!.equipe_ext_id).toBe(equipe_ext_id);
    expect(row.rows[0]!.statut).toBe("joue");
    expect(row.rows[0]!.score_dom).toBe(28);
    expect(row.rows[0]!.score_ext).toBe(25);
    expect(row.rows[0]!.equipement_id).toBe("2348");
    expect(row.rows[0]!.salle_id).toBeNull();
    expect(row.rows[0]!.heure_estimee).toBe(false);
  });

  it("deduces statut=a_jouer when scores are null", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R2",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2026-05-27T20:00:00+02:00",
        score_dom: null,
        score_ext: null,
        journee: 25,
        source_url: "https://x/",
      },
      "R2",
    );
    const report = await runMatchsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    const row = await query<{ statut: string }>(`SELECT statut FROM core.matchs WHERE id_ffhb_match='R2'`);
    expect(row.rows[0]!.statut).toBe("a_jouer");
  });

  it("deduces heure_estimee=true when date_heure ends with T00:00:00", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R3",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2026-05-27T00:00:00+02:00",
        journee: 1,
        source_url: "https://x/",
      },
      "R3",
    );
    await runMatchsEtl(SAISON);
    const row = await query<{ heure_estimee: boolean }>(`SELECT heure_estimee FROM core.matchs WHERE id_ffhb_match='R3'`);
    expect(row.rows[0]!.heure_estimee).toBe(true);
  });

  it("warns and skips when poule FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R4",
        ext_poule_id: "GHOST",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2026-05-27T20:00:00+02:00",
        journee: 1,
        source_url: "https://x/",
      },
      "R4",
    );
    const report = await runMatchsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips when equipe_dom FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R5",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "GHOST",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2026-05-27T20:00:00+02:00",
        journee: 1,
        source_url: "https://x/",
      },
      "R5",
    );
    const report = await runMatchsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips when equipe_ext FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R6",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "GHOST",
        date_heure: "2026-05-27T20:00:00+02:00",
        journee: 1,
        source_url: "https://x/",
      },
      "R6",
    );
    const report = await runMatchsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("rejects invalid payload (Zod fail)", async () => {
    await insertRawMatch({ junk: true } as object, "BAD");
    const report = await runMatchsEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run → 1 ligne)", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R7",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2026-05-27T20:00:00+02:00",
        journee: 1,
        source_url: "https://x/",
      },
      "R7",
    );
    await runMatchsEtl(SAISON);
    await runMatchsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.matchs`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  it("updates statut when score transitions from null to set (a_jouer → joue)", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    // First insert : à venir
    await insertRawMatch(
      {
        ext_rencontre_id: "R8",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2025-09-03T20:00:00+02:00",
        score_dom: null,
        score_ext: null,
        journee: 1,
        source_url: "https://x/",
      },
      "R8",
    );
    await runMatchsEtl(SAISON);
    const before = await query<{ statut: string; updated_at: Date }>(
      `SELECT statut, updated_at FROM core.matchs WHERE id_ffhb_match='R8'`,
    );
    expect(before.rows[0]!.statut).toBe("a_jouer");

    await new Promise((r) => setTimeout(r, 50));

    // Second insert : joué (scores remplis)
    await insertRawMatch(
      {
        ext_rencontre_id: "R8",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_EXT",
        date_heure: "2025-09-03T20:00:00+02:00",
        score_dom: 28,
        score_ext: 25,
        journee: 1,
        source_url: "https://x/",
      },
      "R8",
    );
    await runMatchsEtl(SAISON);
    const after = await query<{ statut: string; score_dom: number; updated_at: Date }>(
      `SELECT statut, score_dom, updated_at FROM core.matchs WHERE id_ffhb_match='R8'`,
    );
    expect(after.rows[0]!.statut).toBe("joue");
    expect(after.rows[0]!.score_dom).toBe(28);
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.rows[0]!.updated_at.getTime());
  });

  it("skips when equipe_dom_id === equipe_ext_id after FK resolution", async () => {
    await seedHierarchy("PO1", "EQ_DOM", "EQ_EXT");
    await insertRawMatch(
      {
        ext_rencontre_id: "R9",
        ext_poule_id: "PO1",
        ext_equipe_dom_id: "EQ_DOM",
        ext_equipe_ext_id: "EQ_DOM",   // Same as dom
        date_heure: "2026-05-27T20:00:00+02:00",
        journee: 1,
        source_url: "https://x/",
      },
      "R9",
    );
    const report = await runMatchsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  afterAll(async () => {
    await closePool();
  });
});
