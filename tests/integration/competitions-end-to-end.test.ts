// tests/integration/competitions-end-to-end.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, closePool } from "@/db/client.js";
import { parseCompetitionList } from "@/scrapers/ffhandball/competition-list.scraper.js";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";

const SAISON = "2025-2026";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

async function setup(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("competitions end-to-end", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.competitions; DELETE FROM raw.phases; DELETE FROM raw.poules;`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setup();
  });

  it("scrapes → ETLs → core in correct order", async () => {
    const run_id = await startRun();

    // 1. parser+inserer competitions depuis fixture national
    const compHtml = fixture("ffhandball-competitions-national.html");
    const sourceUrl = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/";
    const comps = parseCompetitionList(compHtml, "national", sourceUrl, "2025-2026", "21");
    for (const c of comps) {
      await insertRaw("competitions", {
        scrape_run_id: run_id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.ext_competition_id,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    expect(comps.length).toBeGreaterThan(0);

    // 2. Pour une compétition connue (LBE), parser+inserer phases+poules
    const lbe = comps.find((c) => c.ext_competition_id === "28227");
    expect(lbe).toBeDefined();
    const detailHtml = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(detailHtml, lbe!.detail_url, lbe!.ext_competition_id);
    expect(r).not.toBeNull();
    for (const ph of r!.phases) {
      await insertRaw("phases", {
        scrape_run_id: run_id,
        source_url: ph.source_url,
        source_site: "ffhandball.fr",
        natural_key: ph.ext_phase_id,
        payload: ph,
        saison: SAISON,
        http_status: 200,
      });
    }
    for (const po of r!.poules) {
      await insertRaw("poules", {
        scrape_run_id: run_id,
        source_url: po.source_url,
        source_site: "ffhandball.fr",
        natural_key: po.ext_poule_id,
        payload: po,
        saison: SAISON,
        http_status: 200,
      });
    }

    // 3. Run les 3 ETLs dans l'ordre
    const c1 = await runCompetitionsEtl(SAISON);
    expect(c1.rows_inserted).toBeGreaterThan(0);

    const p1 = await runPhasesEtl(SAISON);
    expect(p1.rows_inserted).toBeGreaterThan(0);
    expect(p1.warnings_count).toBe(0); // FK competition résolue

    const po1 = await runPoulesEtl(SAISON);
    expect(po1.rows_inserted).toBeGreaterThan(0);
    expect(po1.warnings_count).toBe(0); // FK phase résolue

    // 4. Vérifier l'état final
    const finalComp = await query(`SELECT * FROM core.competitions WHERE id_ffhb = '28227'`);
    expect(finalComp.rowCount).toBe(1);
    const finalPhase = await query(`SELECT * FROM core.phases WHERE id_ffhb = $1`, [
      r!.phases[0]!.ext_phase_id,
    ]);
    expect(finalPhase.rowCount).toBe(1);
    const finalPoule = await query(`SELECT * FROM core.poules WHERE id_ffhb = $1`, [
      r!.poules[0]!.ext_poule_id,
    ]);
    expect(finalPoule.rowCount).toBe(1);
  });

  it("is idempotent end-to-end (re-run = same counts)", async () => {
    const run_id = await startRun();
    const compHtml = fixture("ffhandball-competitions-national.html");
    const comps = parseCompetitionList(compHtml, "national", "https://x/", "2025-2026", "21");
    for (const c of comps) {
      await insertRaw("competitions", {
        scrape_run_id: run_id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.ext_competition_id,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    await runCompetitionsEtl(SAISON);
    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.competitions`)).rows[0]!.count;
    await runCompetitionsEtl(SAISON);
    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.competitions`)).rows[0]!.count;
    expect(after).toBe(before);
  });

  afterAll(async () => {
    await closePool();
  });
});
