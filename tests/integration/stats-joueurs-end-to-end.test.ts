// tests/integration/stats-joueurs-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseStatsJoueurs } from "@/scrapers/ffhandball/stats-joueurs.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runStatsJoueursEtl } from "@/etl/stats-joueurs.etl.js";

const SAISON = "2025-2026";
const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/statistiques/";
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

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','stats-joueurs',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("stats-joueurs end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.stats_joueurs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='stats-joueurs'`);
    await query(`TRUNCATE core.stats_joueurs, core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();

    // Seed competition + phase + poule + qq équipes connues
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
    // Seed 2 équipes connues (parmi les 14 que la fixture mentionne)
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ('E1', 'HANDBALL PLAN DE CUQUES', $1),
              ('E2', 'PARIS 92', $1)
       ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
      [SAISON],
    );
  });

  it("parses LBE fixture → 287 lignes core.stats_joueurs, équipes partiellement résolues", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-stats-lbe.html");
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    expect(r.length).toBe(287);

    for (const s of r) {
      await insertRaw("stats_joueurs", {
        scrape_run_id: run_id, source_url: s.source_url, source_site: "ffhandball.fr",
        natural_key: `${s.ext_poule_id}-${s.individu_id}`,
        payload: s, saison: SAISON, http_status: 200,
      });
    }

    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(287);
    // Beaucoup de warnings attendus (12 équipes non seeded sur 14)
    expect(report.warnings_count).toBeGreaterThan(0);

    // Vérifier que des équipes connues sont bien résolues
    const resolved = await query<{ count: string }>(
      `SELECT count(*) FROM core.stats_joueurs WHERE equipe_id IS NOT NULL`,
    );
    expect(Number(resolved.rows[0]!.count)).toBeGreaterThan(0);

    // Top buteur ANTONISSEN doit être là
    const top = await query<{ total_buts: number; nom: string }>(
      `SELECT total_buts, nom FROM core.stats_joueurs
       ORDER BY total_buts DESC LIMIT 1`,
    );
    expect(top.rows[0]!.nom).toBe("ANTONISSEN");
    expect(top.rows[0]!.total_buts).toBe(195);
  });

  it("is idempotent (re-run = same count, capture_date bumps)", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-stats-lbe.html");
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    for (const s of r) {
      await insertRaw("stats_joueurs", {
        scrape_run_id: run_id, source_url: s.source_url, source_site: "ffhandball.fr",
        natural_key: `${s.ext_poule_id}-${s.individu_id}`,
        payload: s, saison: SAISON, http_status: 200,
      });
    }
    await runStatsJoueursEtl(SAISON);

    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.stats_joueurs`)).rows[0]!.count;
    const beforeDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.stats_joueurs LIMIT 1`)).rows[0]!.capture_date;

    await new Promise((r) => setTimeout(r, 50));
    await runStatsJoueursEtl(SAISON);

    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.stats_joueurs`)).rows[0]!.count;
    const afterDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.stats_joueurs ORDER BY id LIMIT 1`)).rows[0]!.capture_date;

    expect(after).toBe(before);
    expect(afterDate.getTime()).toBeGreaterThan(beforeDate.getTime());
  });
});
