// tests/etl/equipes.etl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runEquipesEtl } from "@/etl/equipes.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function insertRawEquipe(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.equipes (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runEquipesEtl", () => {
  beforeEach(async () => {
    // Cleanup respecting FKs
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await query(`TRUNCATE core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.clubs, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts equipe with club_id NULL + warning", async () => {
    await insertRawEquipe(
      {
        ext_equipe_id: "EQ1",
        nom: "BREST BRETAGNE HANDBALL",
        ext_structure_id: "1720",
        logo: "logo.jpg",
        source_url: "https://x/",
      },
      "EQ1",
    );
    const report = await runEquipesEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(1);

    const row = await query<{
      nom: string;
      club_id: number | null;
      ext_structure_id: string | null;
      logo: string | null;
    }>(`SELECT nom, club_id, ext_structure_id, logo FROM core.equipes WHERE id_ffhb = 'EQ1'`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.club_id).toBeNull();
    expect(row.rows[0]!.ext_structure_id).toBe("1720");
    expect(row.rows[0]!.logo).toBe("logo.jpg");
  });

  it("résout club_id quand un club correspond à ext_structure_id (sans warning)", async () => {
    await query(`INSERT INTO core.clubs (id_ffhb, nom) VALUES ('1720', 'BREST BRETAGNE HANDBALL') ON CONFLICT DO NOTHING`);
    await insertRawEquipe(
      { ext_equipe_id: "EQ2", nom: "BREST BB", ext_structure_id: "1720", source_url: "https://x/" },
      "EQ2",
    );
    const report = await runEquipesEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0); // club trouvé → plus de warning

    const row = await query<{ club_id: number | null }>(
      `SELECT e.club_id FROM core.equipes e WHERE e.id_ffhb = 'EQ2'`,
    );
    expect(row.rows[0]!.club_id).not.toBeNull();
  });

  it("rejects invalid payload", async () => {
    await insertRawEquipe({ junk: true } as object, "BAD");
    const report = await runEquipesEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run → 1 ligne, 2 warnings total over 2 runs)", async () => {
    await insertRawEquipe(
      { ext_equipe_id: "EQ1", nom: "X", source_url: "https://x/" },
      "EQ1",
    );
    await runEquipesEtl(SAISON);
    await runEquipesEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.equipes`);
    expect(Number(r.rows[0]!.count)).toBe(1);
    const w = await query<{ count: string }>(`SELECT count(*) FROM core.etl_warnings WHERE entity='equipes'`);
    expect(Number(w.rows[0]!.count)).toBe(2);
  });

  it("updates equipe when nom or logo changes (updated_at bumps)", async () => {
    await insertRawEquipe(
      { ext_equipe_id: "EQ1", nom: "Old name", logo: "old.jpg", source_url: "https://x/" },
      "EQ1",
    );
    await runEquipesEtl(SAISON);
    const before = await query<{ updated_at: Date }>(`SELECT updated_at FROM core.equipes WHERE id_ffhb='EQ1'`);

    // Sleep a tiny bit to ensure clock difference
    await new Promise((r) => setTimeout(r, 50));

    await insertRawEquipe(
      { ext_equipe_id: "EQ1", nom: "New name", logo: "new.jpg", source_url: "https://x/" },
      "EQ1",
    );
    await runEquipesEtl(SAISON);
    const after = await query<{ updated_at: Date; nom: string; logo: string | null }>(
      `SELECT updated_at, nom, logo FROM core.equipes WHERE id_ffhb='EQ1'`,
    );
    expect(after.rows[0]!.nom).toBe("New name");
    expect(after.rows[0]!.logo).toBe("new.jpg");
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.rows[0]!.updated_at.getTime());
  });
});
