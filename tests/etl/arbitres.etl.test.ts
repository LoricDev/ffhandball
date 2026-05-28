// tests/etl/arbitres.etl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runArbitresEtl } from "@/etl/arbitres.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
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

describe("runArbitresEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='matchs'`);
    await query(`TRUNCATE core.match_officiels, core.arbitres, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("extracts unique arbitres from raw.matchs (UNION arbitre1 + arbitre2)", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
        arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME",
      },
      "M1",
    );
    await insertRawMatch(
      {
        ext_rencontre_id: "M2",
        arbitre1_id: "A3", arbitre1_nom: "COURNIL MATHILDE",
        arbitre2_id: "A4", arbitre2_nom: "LAMOUR LORIANE",
      },
      "M2",
    );
    const report = await runArbitresEtl(SAISON);
    expect(report.rows_inserted).toBe(4);
    const all = await query<{ id_ffhb: string; nom: string; prenom: string }>(
      `SELECT id_ffhb, nom, prenom FROM core.arbitres ORDER BY id_ffhb`,
    );
    expect(all.rowCount).toBe(4);
    expect(all.rows.map((r) => r.id_ffhb)).toEqual(["A1", "A2", "A3", "A4"]);
  });

  it("deduplicates same arbitre appearing in multiple matchs", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
        arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME",
      },
      "M1",
    );
    await insertRawMatch(
      {
        ext_rencontre_id: "M2",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",  // same as M1
        arbitre2_id: "A3", arbitre2_nom: "AUTRE NOM",
      },
      "M2",
    );
    const report = await runArbitresEtl(SAISON);
    expect(report.rows_inserted).toBe(3);  // A1, A2, A3 (pas 4)
    const a1 = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres WHERE id_ffhb = 'A1'`);
    expect(Number(a1.rows[0]!.count)).toBe(1);
  });

  it("splits nom_complet into nom + prenom + stores nom_complet brut", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
      },
      "M1",
    );
    await runArbitresEtl(SAISON);
    const a1 = await query<{ nom: string; prenom: string | null; nom_complet: string | null }>(
      `SELECT nom, prenom, nom_complet FROM core.arbitres WHERE id_ffhb = 'A1'`,
    );
    expect(a1.rows[0]!.nom).toBe("CHAMI");
    expect(a1.rows[0]!.prenom).toBe("MILOUD");
    expect(a1.rows[0]!.nom_complet).toBe("CHAMI MILOUD");
  });

  it("skips raw matchs with no arbitre data", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        // No arbitre1_id or arbitre2_id
      },
      "M1",
    );
    const report = await runArbitresEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    const all = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`);
    expect(Number(all.rows[0]!.count)).toBe(0);
  });

  it("is idempotent (re-run → same counts)", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
      },
      "M1",
    );
    await runArbitresEtl(SAISON);
    await runArbitresEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });
});
