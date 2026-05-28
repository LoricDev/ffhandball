// tests/integration/classements-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseClassement } from "@/scrapers/ffhandball/classement.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runClassementsEtl } from "@/etl/classements.etl.js";

const SAISON = "2025-2026";
const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/classements/";
const EXT_POULE_ID = "168256";

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

async function seedAllEquipes(classements: Array<{ ext_equipe_id: string }>): Promise<void> {
  const ids = new Set<string>();
  for (const c of classements) ids.add(c.ext_equipe_id);
  for (const id of ids) {
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ($1, 'Equipe', $2)
       ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
      [id, SAISON],
    );
  }
}

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','classements',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("classements end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.classements`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='classements'`);
    await query(`TRUNCATE core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();

    // Seed competition + phase + poule (mais pas équipes — seedées dynamiquement)
    const comp = await query<{ id: number }>(
      `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
       VALUES ('28227', 'LBE', 'national', $1) RETURNING id`,
      [SAISON],
    );
    const phase = await query<{ id: number }>(
      `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
       VALUES ('PH1', $1, 'P', $2) RETURNING id`,
      [comp.rows[0]!.id, SAISON],
    );
    await query(
      `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
       VALUES ($1, $2, 'POULE UNIQUE', $3)`,
      [EXT_POULE_ID, phase.rows[0]!.id, SAISON],
    );
  });

  it("parses LBE fixture → 14 lignes core.classements with FKs resolved", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(14);

    await seedAllEquipes(r!);

    for (const c of r!) {
      await insertRaw("classements", {
        scrape_run_id: run_id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.ext_classement_id,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }

    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(14);
    expect(report.warnings_count).toBe(0);

    const counts = await query<{ count: string }>(
      `SELECT count(*) FROM core.classements`,
    );
    expect(Number(counts.rows[0]!.count)).toBe(14);

    // Vérifier que la position 1 a le plus de points
    const first = await query<{ points: number }>(
      `SELECT points FROM core.classements WHERE position = 1`,
    );
    const last = await query<{ points: number }>(
      `SELECT points FROM core.classements WHERE position = 14`,
    );
    expect(first.rows[0]!.points).toBeGreaterThan(last.rows[0]!.points);
  });

  it("is idempotent (re-run ETL = same count, capture_date bumps)", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID)!;
    await seedAllEquipes(r);
    for (const c of r) {
      await insertRaw("classements", {
        scrape_run_id: run_id, source_url: c.source_url, source_site: "ffhandball.fr",
        natural_key: c.ext_classement_id, payload: c, saison: SAISON, http_status: 200,
      });
    }
    await runClassementsEtl(SAISON);

    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.classements`)).rows[0]!.count;
    const beforeDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.classements WHERE position = 1`)).rows[0]!.capture_date;

    await new Promise((r) => setTimeout(r, 50));
    await runClassementsEtl(SAISON);

    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.classements`)).rows[0]!.count;
    const afterDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.classements WHERE position = 1`)).rows[0]!.capture_date;

    expect(after).toBe(before);
    expect(afterDate.getTime()).toBeGreaterThan(beforeDate.getTime());
  });
});
