// tests/integration/feuilles-match-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { query } from "@/db/client.js";
import { parseFdmPdf } from "@/scrapers/ffhandball/fdm-pdf.parser.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runFeuillesMatchEtl } from "@/etl/feuilles-match.etl.js";

const SAISON = "2025-2026";
const FDM_CODE = "VAGPOQJ";
const FDM_URL = `https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/${FDM_CODE}.pdf`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixturePath(name: string): string {
  return path.join(__dirname, "../fixtures", name);
}

async function setup(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
  // Seed hierarchy
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1','Honneur Moselle','departemental',$1) RETURNING id`,
    [SAISON],
  );
  const phase = await query<{ id: number }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ('PH1', $1, 'P', $2) RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const poule = await query<{ id: number }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
     VALUES ('PO1', $1, 'P3', $2) RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EDOM','ETAIN',$1) RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EEXT','SARRALBE',$1) RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, fdm_code)
     VALUES ('M_REAL', $1, $2, $3, '2026-04-25T20:30:00+02:00', $4)`,
    [poule.rows[0]!.id, eqDom.rows[0]!.id, eqExt.rows[0]!.id, FDM_CODE],
  );
}

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('media-ffhb-fdm.ffhandball.fr','feuilles-match',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("feuilles-match end-to-end", () => {
  beforeEach(async () => {
    // Delete all raw tables that reference scrape_runs first
    await query(`DELETE FROM raw.feuilles_match`);
    await query(`DELETE FROM raw.stats_joueurs`);
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.arbitres`);
    await query(`DELETE FROM raw.classements`);
    await query(`DELETE FROM raw.joueurs`);
    await query(`DELETE FROM raw.salles`);
    await query(`DELETE FROM raw.clubs`);
    await query(`DELETE FROM raw.scrape_runs`);
    await query(`TRUNCATE core.match_actions, core.match_compositions, core.match_officiels, core.joueurs, core.matchs, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.arbitres, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();
  });

  it("parse FdM real PDF → ETL → joueurs + compositions + actions in core", async () => {
    const run_id = await startRun();
    const buf = await readFile(fixturePath(`fdm-${FDM_CODE}.pdf`));
    const parsed = await parseFdmPdf(buf, FDM_URL, FDM_CODE);
    expect(parsed).not.toBeNull();

    await insertRaw("feuilles_match", {
      scrape_run_id: run_id,
      source_url: FDM_URL,
      source_site: "media-ffhb-fdm.ffhandball.fr",
      natural_key: FDM_CODE,
      payload: parsed!,
      saison: SAISON,
      http_status: 200,
    });

    const report = await runFeuillesMatchEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);

    // Vérifications
    const joueurs = await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`);
    expect(Number(joueurs.rows[0]!.count)).toBeGreaterThan(15);  // ~20 joueurs (les 2 compos)

    const compos = await query<{ count: string }>(`SELECT count(*) FROM core.match_compositions`);
    expect(Number(compos.rows[0]!.count)).toBeGreaterThan(15);

    const actions = await query<{ count: string }>(`SELECT count(*) FROM core.match_actions`);
    expect(Number(actions.rows[0]!.count)).toBeGreaterThan(40);  // déroulé complet

    // fdm_url propagé
    const m = await query<{ fdm_url: string | null }>(
      `SELECT fdm_url FROM core.matchs WHERE fdm_code = $1`,
      [FDM_CODE],
    );
    expect(m.rows[0]!.fdm_url).toContain(`${FDM_CODE}.pdf`);
  });
});
