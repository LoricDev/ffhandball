// tests/integration/arbitres-officiels-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runArbitresEtl } from "@/etl/arbitres.etl.js";
import { runMatchOfficielsEtl } from "@/etl/match_officiels.etl.js";

const SAISON = "2025-2026";

async function setup(): Promise<void> {
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
     VALUES ('C1','C','national',$1) ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const phase = await query<{ id: number }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ('PH1', $1, 'P', $2) ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const poule = await query<{ id: number }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
     VALUES ('PO1', $1, 'Poule', $2) ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EDOM','Dom',$1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EEXT','Ext',$1)
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

describe("arbitres + match_officiels end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='matchs'`);
    await query(`TRUNCATE core.match_officiels, core.matchs, core.arbitres, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();
  });

  it("3 matchs → arbitres ETL → match_officiels ETL → core populated correctly", async () => {
    // Seed 3 matchs (chacun avec ses 2 arbitres, certains arbitres répétés)
    const { match_id: m1 } = await seedHierarchy("M1");
    const { match_id: m2 } = await seedHierarchy("M2");
    const { match_id: m3 } = await seedHierarchy("M3");
    // Note: seedHierarchy re-utilise les mêmes competition/phase/poule à cause des ON CONFLICT,
    // mais crée 3 matchs distincts
    void m1; void m2; void m3;

    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD", arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME" },
      "M1",
    );
    await insertRawMatch(
      { ext_rencontre_id: "M2", arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD", arbitre2_id: "A3", arbitre2_nom: "COURNIL MATHILDE" },
      "M2",
    );
    await insertRawMatch(
      { ext_rencontre_id: "M3", arbitre1_id: "A2", arbitre1_nom: "MILI AISSAME", arbitre2_id: "A3", arbitre2_nom: "COURNIL MATHILDE" },
      "M3",
    );

    // Run arbitres puis match_officiels
    const arbReport = await runArbitresEtl(SAISON);
    expect(arbReport.rows_inserted).toBe(3); // A1, A2, A3 (déduplication)
    expect(arbReport.warnings_count).toBe(0);

    const officielsReport = await runMatchOfficielsEtl(SAISON);
    expect(officielsReport.rows_inserted).toBe(6); // 3 matchs × 2 arbitres
    expect(officielsReport.warnings_count).toBe(0);

    // Vérifications finales
    const arbCount = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`);
    expect(Number(arbCount.rows[0]!.count)).toBe(3);
    const officielsCount = await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`);
    expect(Number(officielsCount.rows[0]!.count)).toBe(6);

    // A1 a officié dans 2 matchs
    const a1 = await query<{ count: string }>(
      `SELECT count(*) FROM core.match_officiels mo
       JOIN core.arbitres a ON a.id = mo.arbitre_id
       WHERE a.id_ffhb = 'A1'`,
    );
    expect(Number(a1.rows[0]!.count)).toBe(2);

    // Split nom/prenom OK
    const chami = await query<{ nom: string; prenom: string | null; nom_complet: string | null }>(
      `SELECT nom, prenom, nom_complet FROM core.arbitres WHERE id_ffhb = 'A1'`,
    );
    expect(chami.rows[0]!.nom).toBe("CHAMI");
    expect(chami.rows[0]!.prenom).toBe("MILOUD");
    expect(chami.rows[0]!.nom_complet).toBe("CHAMI MILOUD");
  });

  it("is idempotent (re-run ETLs = same counts)", async () => {
    await seedHierarchy("M1");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD", arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME" },
      "M1",
    );
    await runArbitresEtl(SAISON);
    await runMatchOfficielsEtl(SAISON);

    const beforeArb = (await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`)).rows[0]!.count;
    const beforeOff = (await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`)).rows[0]!.count;

    await runArbitresEtl(SAISON);
    await runMatchOfficielsEtl(SAISON);

    const afterArb = (await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`)).rows[0]!.count;
    const afterOff = (await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`)).rows[0]!.count;

    expect(afterArb).toBe(beforeArb);
    expect(afterOff).toBe(beforeOff);
  });
});
