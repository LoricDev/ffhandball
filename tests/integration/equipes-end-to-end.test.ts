// tests/integration/equipes-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseCompetitionList } from "@/scrapers/ffhandball/competition-list.scraper.js";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";
import { runEquipesEtl } from "@/etl/equipes.etl.js";
import { runEngagementsEtl } from "@/etl/engagements.etl.js";

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

describe("equipes + engagements end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.engagements; DELETE FROM raw.equipes; DELETE FROM raw.poules; DELETE FROM raw.phases; DELETE FROM raw.competitions;`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await query(`TRUNCATE core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();
  });

  it("scrapes mono-poule LBE → 5 ETLs in order → core populated", async () => {
    const run_id = await startRun();

    // 1. Parse + insertRaw competitions
    const compHtml = fixture("ffhandball-competitions-national.html");
    const sourceUrl = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/";
    const comps = parseCompetitionList(compHtml, "national", sourceUrl, "2025-2026", "21");
    const lbe = comps.find((c) => c.ext_competition_id === "28227");
    expect(lbe).toBeDefined();
    await insertRaw("competitions", {
      scrape_run_id: run_id,
      source_url: lbe!.source_url,
      source_site: "ffhandball.fr",
      natural_key: lbe!.ext_competition_id,
      payload: lbe!,
      saison: SAISON,
      http_status: 200,
    });

    // 2. Parse fixture détail (LBE — 14 équipes, 1 phase, 1 poule)
    const detailHtml = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(detailHtml, lbe!.detail_url, lbe!.ext_competition_id);
    expect(r).not.toBeNull();
    expect(r!.equipes.length).toBe(14);
    expect(r!.engagements.length).toBe(14);

    for (const ph of r!.phases) {
      await insertRaw("phases", { scrape_run_id: run_id, source_url: ph.source_url, source_site: "ffhandball.fr", natural_key: ph.ext_phase_id, payload: ph, saison: SAISON, http_status: 200 });
    }
    for (const po of r!.poules) {
      await insertRaw("poules", { scrape_run_id: run_id, source_url: po.source_url, source_site: "ffhandball.fr", natural_key: po.ext_poule_id, payload: po, saison: SAISON, http_status: 200 });
    }
    for (const eq of r!.equipes) {
      await insertRaw("equipes", { scrape_run_id: run_id, source_url: eq.source_url, source_site: "ffhandball.fr", natural_key: eq.ext_equipe_id, payload: eq, saison: SAISON, http_status: 200 });
    }
    for (const en of r!.engagements) {
      await insertRaw("engagements", { scrape_run_id: run_id, source_url: en.source_url, source_site: "ffhandball.fr", natural_key: `${en.ext_equipe_id}-${en.ext_poule_id}`, payload: en, saison: SAISON, http_status: 200 });
    }

    // 3. Run 5 ETLs in order
    const c1 = await runCompetitionsEtl(SAISON);
    expect(c1.rows_inserted).toBe(1);
    const p1 = await runPhasesEtl(SAISON);
    expect(p1.rows_inserted).toBe(1);
    expect(p1.warnings_count).toBe(0);
    const po1 = await runPoulesEtl(SAISON);
    expect(po1.rows_inserted).toBe(1);
    expect(po1.warnings_count).toBe(0);
    const eq1 = await runEquipesEtl(SAISON);
    expect(eq1.rows_inserted).toBe(14);
    expect(eq1.warnings_count).toBe(14); // un par équipe (club_id NULL)
    const en1 = await runEngagementsEtl(SAISON);
    expect(en1.rows_inserted).toBe(14);
    expect(en1.warnings_count).toBe(0); // FKs résolues

    // 4. Vérifications finales
    const counts = await query<{ t: string; c: string }>(
      `SELECT 'equipes' AS t, count(*)::text AS c FROM core.equipes
       UNION ALL SELECT 'engagements', count(*)::text FROM core.engagements`,
    );
    const map = new Map(counts.rows.map((row) => [row.t, Number(row.c)]));
    expect(map.get("equipes")).toBe(14);
    expect(map.get("engagements")).toBe(14);

    // Toutes les équipes ont club_id NULL
    const nullCount = await query<{ count: string }>(
      `SELECT count(*) FROM core.equipes WHERE club_id IS NULL`,
    );
    expect(Number(nullCount.rows[0]!.count)).toBe(14);
  });

  it("is idempotent end-to-end (re-run ETLs = same counts)", async () => {
    const run_id = await startRun();
    const compHtml = fixture("ffhandball-competitions-national.html");
    const comps = parseCompetitionList(compHtml, "national", "https://x/", "2025-2026", "21");
    const lbe = comps.find((c) => c.ext_competition_id === "28227")!;
    await insertRaw("competitions", { scrape_run_id: run_id, source_url: lbe.source_url, source_site: "ffhandball.fr", natural_key: lbe.ext_competition_id, payload: lbe, saison: SAISON, http_status: 200 });
    const detailHtml = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(detailHtml, lbe.detail_url, lbe.ext_competition_id)!;
    for (const ph of r.phases) await insertRaw("phases", { scrape_run_id: run_id, source_url: ph.source_url, source_site: "ffhandball.fr", natural_key: ph.ext_phase_id, payload: ph, saison: SAISON, http_status: 200 });
    for (const po of r.poules) await insertRaw("poules", { scrape_run_id: run_id, source_url: po.source_url, source_site: "ffhandball.fr", natural_key: po.ext_poule_id, payload: po, saison: SAISON, http_status: 200 });
    for (const eq of r.equipes) await insertRaw("equipes", { scrape_run_id: run_id, source_url: eq.source_url, source_site: "ffhandball.fr", natural_key: eq.ext_equipe_id, payload: eq, saison: SAISON, http_status: 200 });
    for (const en of r.engagements) await insertRaw("engagements", { scrape_run_id: run_id, source_url: en.source_url, source_site: "ffhandball.fr", natural_key: `${en.ext_equipe_id}-${en.ext_poule_id}`, payload: en, saison: SAISON, http_status: 200 });

    await runCompetitionsEtl(SAISON);
    await runPhasesEtl(SAISON);
    await runPoulesEtl(SAISON);
    await runEquipesEtl(SAISON);
    await runEngagementsEtl(SAISON);

    const before_eq = (await query<{ count: string }>(`SELECT count(*) FROM core.equipes`)).rows[0]!.count;
    const before_en = (await query<{ count: string }>(`SELECT count(*) FROM core.engagements`)).rows[0]!.count;

    await runEquipesEtl(SAISON);
    await runEngagementsEtl(SAISON);

    const after_eq = (await query<{ count: string }>(`SELECT count(*) FROM core.equipes`)).rows[0]!.count;
    const after_en = (await query<{ count: string }>(`SELECT count(*) FROM core.engagements`)).rows[0]!.count;
    expect(after_eq).toBe(before_eq);
    expect(after_en).toBe(before_en);
  });
});
