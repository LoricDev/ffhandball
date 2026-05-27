// tests/integration/matchs-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseRencontreList } from "@/scrapers/ffhandball/rencontre-list.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runMatchsEtl } from "@/etl/matchs.etl.js";

const SAISON = "2025-2026";
const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/";
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

async function seedAllEquipes(matchs: Array<{ ext_equipe_dom_id: string; ext_equipe_ext_id: string }>): Promise<void> {
  const ids = new Set<string>();
  for (const m of matchs) {
    ids.add(m.ext_equipe_dom_id);
    ids.add(m.ext_equipe_ext_id);
  }
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
     VALUES ('ffhandball.fr','matchs',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("matchs end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name IN ('competitions','matchs')`);
    await query(`TRUNCATE core.matchs, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();

    // Seed competition + phase + poule
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

  it("parses journée 1 fixture → ETL → core matchs with FKs and statut=joue", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-rencontres-journee-1.html");
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.matchs.length).toBeGreaterThan(0);

    // Seed équipes mentionnées
    await seedAllEquipes(r!.matchs);

    // InsertRaw all matchs
    for (const m of r!.matchs) {
      await insertRaw("matchs", {
        scrape_run_id: run_id,
        source_url: m.source_url,
        source_site: "ffhandball.fr",
        natural_key: m.ext_rencontre_id,
        payload: m,
        saison: SAISON,
        http_status: 200,
      });
    }

    const report = await runMatchsEtl(SAISON);
    expect(report.rows_inserted).toBe(r!.matchs.length);
    expect(report.warnings_count).toBe(0);

    // Au moins un match a statut=joue (journée 1 → matchs joués)
    const joued = await query<{ count: string }>(
      `SELECT count(*) FROM core.matchs WHERE statut='joue'`,
    );
    expect(Number(joued.rows[0]!.count)).toBeGreaterThan(0);
  });

  it("is idempotent (re-run ETL = same count)", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-rencontres-journee-1.html");
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID)!;
    await seedAllEquipes(r.matchs);
    for (const m of r.matchs) {
      await insertRaw("matchs", {
        scrape_run_id: run_id, source_url: m.source_url, source_site: "ffhandball.fr",
        natural_key: m.ext_rencontre_id, payload: m, saison: SAISON, http_status: 200,
      });
    }
    await runMatchsEtl(SAISON);
    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.matchs`)).rows[0]!.count;
    await runMatchsEtl(SAISON);
    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.matchs`)).rows[0]!.count;
    expect(after).toBe(before);
  });
});
