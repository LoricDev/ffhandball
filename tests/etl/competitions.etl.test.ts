// tests/etl/competitions.etl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";

const SAISON = "2025-2026";

async function setupBaseSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
}

async function insertRawCompetition(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.competitions
       (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runCompetitionsEtl", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.competitions, core.etl_runs, core.etl_rejets, core.etl_warnings RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setupBaseSaison();
  });

  it("inserts a competition from a valid payload", async () => {
    await insertRawCompetition(
      {
        ext_competition_id: "28227",
        nom: "LIGUE BUTAGAZ ENERGIE 2025-26",
        niveau: "national",
        sexe: "F",
        code: "001",
        ext_structure_id: "1",
        detail_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
        source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/",
      },
      "28227",
    );
    const report = await runCompetitionsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.rows_rejected).toBe(0);

    const row = await query<{ id_ffhb: string; nom: string; niveau: string; sexe: string }>(
      `SELECT id_ffhb, nom, niveau, sexe FROM core.competitions WHERE id_ffhb = '28227'`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.niveau).toBe("national");
    expect(row.rows[0]!.sexe).toBe("F");
  });

  it("rejects invalid payload to etl_rejets", async () => {
    await insertRawCompetition({ junk: true } as object, "BAD");
    const report = await runCompetitionsEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
    const rej = await query(`SELECT count(*) FROM core.etl_rejets WHERE entity = 'competitions'`);
    expect(Number((rej.rows[0] as { count: string }).count)).toBe(1);
  });

  it("is idempotent (re-run does not duplicate)", async () => {
    await insertRawCompetition(
      {
        ext_competition_id: "X1",
        nom: "Test",
        niveau: "regional",
        detail_url: "https://x/",
        source_url: "https://x/",
      },
      "X1",
    );
    await runCompetitionsEtl(SAISON);
    await runCompetitionsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.competitions`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });
});
