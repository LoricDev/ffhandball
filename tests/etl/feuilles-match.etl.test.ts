// tests/etl/feuilles-match.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runFeuillesMatchEtl } from "@/etl/feuilles-match.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedMatchWithFdmCode(extMatchId: string, fdmCode: string): Promise<{ match_id: number }> {
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
     VALUES ('PO1', $1, 'P', $2) ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EDOM','ETAIN',$1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EEXT','SARRALBE',$1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const m = await query<{ id: number }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, fdm_code)
     VALUES ($1, $2, $3, $4, '2026-04-25T20:30:00+02:00', $5) RETURNING id`,
    [extMatchId, poule.rows[0]!.id, eqDom.rows[0]!.id, eqExt.rows[0]!.id, fdmCode],
  );
  return { match_id: m.rows[0]!.id };
}

async function insertRawFdm(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('media-ffhb-fdm.ffhandball.fr','feuilles-match',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.feuilles_match (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','media-ffhb-fdm.ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

function buildFdmPayload(fdmCode: string): object {
  return {
    fdm_code: fdmCode,
    competition_libelle: "TEST",
    equipe_recevant_libelle: "ETAIN",
    equipe_visiteur_libelle: "SARRALBE",
    date_heure_str: "samedi 25/04/2026 20:30",
    score_recevant: 23,
    score_visiteur: 37,
    score_mi_temps_recevant: 10,
    score_mi_temps_visiteur: 17,
    statut_match: "JOUE",
    officiels: [],
    composition_recevant: [
      {
        numero_licence: "5655011101039", nom: "BAUDSON", prenom: "valentin",
        type_licence: "A", numero_maillot: 25, capitaine: false, gardien: false,
        buts: 3, sept_metres_reussis: null, sept_metres_tentes: null,
        tirs: 8, arrets: null, avertissement: false, exclusions_2min: null, disqualifie: false,
      },
    ],
    composition_visiteur: [
      {
        numero_licence: "5657027101035", nom: "BLATNIK", prenom: "noah",
        type_licence: "A", numero_maillot: 8, capitaine: true, gardien: false,
        buts: 6, sept_metres_reussis: null, sept_metres_tentes: null,
        tirs: 8, arrets: null, avertissement: false, exclusions_2min: null, disqualifie: false,
      },
    ],
    actions: [
      {
        ordre: 0, periode: 1, temps_seconds: 180,
        score_recevant: 1, score_visiteur: 0,
        type_action: "but", cote: "recevant",
        numero_maillot: 25, acteur_role: "joueur",
        description_brute: "But JR N°25 BAUDSON valentin",
      },
    ],
    source_url: "https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/VAGPOQJ.pdf",
  };
}

describe("runFeuillesMatchEtl", () => {
  beforeEach(async () => {
    // Delete all raw tables that reference scrape_runs (to allow full scrape_runs deletion)
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
    await setupSaison();
  });

  it("creates joueurs and compositions when match exists", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    const r = await runFeuillesMatchEtl(SAISON);

    expect(r.rows_inserted).toBeGreaterThan(0);

    const joueurs = await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`);
    expect(Number(joueurs.rows[0]!.count)).toBe(2);

    const compos = await query<{ count: string }>(`SELECT count(*) FROM core.match_compositions`);
    expect(Number(compos.rows[0]!.count)).toBe(2);

    // BAUDSON valentin
    const baudson = await query<{ nom: string; numero_maillot: number; tirs_count: number; but_count: number }>(
      `SELECT j.nom, mc.numero_maillot, mc.tirs_count, mc.but_count
         FROM core.match_compositions mc
         JOIN core.joueurs j ON j.id = mc.joueur_id
         WHERE j.nom = 'BAUDSON'`,
    );
    expect(baudson.rowCount).toBe(1);
    expect(baudson.rows[0]!.numero_maillot).toBe(25);
    expect(baudson.rows[0]!.tirs_count).toBe(8);
    expect(baudson.rows[0]!.but_count).toBe(3);
  });

  it("creates match_actions with ordre + type", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const actions = await query<{ ordre: number; type_action: string; temps_seconds: number }>(
      `SELECT ordre, type_action, temps_seconds FROM core.match_actions ORDER BY ordre`,
    );
    expect(actions.rowCount).toBe(1);
    expect(actions.rows[0]!.type_action).toBe("but");
    expect(actions.rows[0]!.temps_seconds).toBe(180);
  });

  it("updates core.matchs.fdm_url after successful download", async () => {
    const { match_id } = await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const m = await query<{ fdm_url: string | null }>(
      `SELECT fdm_url FROM core.matchs WHERE id = $1`,
      [match_id],
    );
    expect(m.rows[0]!.fdm_url).toContain("VAGPOQJ.pdf");
  });

  it("warns and skips when match (via fdm_code) does not resolve", async () => {
    // Pas de match avec fdm_code VAGPOQJ en core
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    const r = await runFeuillesMatchEtl(SAISON);
    expect(r.warnings_count).toBe(1);
    expect(r.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run = same counts)", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);
    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`)).rows[0]!.count;
    await runFeuillesMatchEtl(SAISON);
    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`)).rows[0]!.count;
    expect(after).toBe(before);

    const compos = (await query<{ count: string }>(`SELECT count(*) FROM core.match_compositions`)).rows[0]!.count;
    expect(Number(compos)).toBe(2);

    const actions = (await query<{ count: string }>(`SELECT count(*) FROM core.match_actions`)).rows[0]!.count;
    expect(Number(actions)).toBe(1);
  });

  it("updates stats when re-run with modified payload", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    // Re-insert avec stats modifiées (5 buts au lieu de 3)
    const updatedPayload = buildFdmPayload("VAGPOQJ");
    (updatedPayload as any).composition_recevant[0].buts = 5;
    await insertRawFdm(updatedPayload, "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const baudson = await query<{ but_count: number }>(
      `SELECT but_count FROM core.match_compositions mc
         JOIN core.joueurs j ON j.id = mc.joueur_id
         WHERE j.nom = 'BAUDSON'`,
    );
    expect(baudson.rows[0]!.but_count).toBe(5);
  });

  it("rejects invalid payload (Zod fail)", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm({ junk: true } as object, "VAGPOQJ");
    const r = await runFeuillesMatchEtl(SAISON);
    expect(r.rows_rejected).toBe(1);
  });

  it("handles action with unknown numero_maillot (joueur_id = NULL)", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    const payload = buildFdmPayload("VAGPOQJ");
    (payload as any).actions[0].numero_maillot = 999;  // orphelin
    await insertRawFdm(payload, "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const action = await query<{ joueur_id: number | null }>(
      `SELECT joueur_id FROM core.match_actions WHERE ordre = 0`,
    );
    expect(action.rows[0]!.joueur_id).toBeNull();
  });

  afterAll(async () => {
    await closePool();
  });
});
