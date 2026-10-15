// Intégration : base de test requise (insère des runs de test, les supprime ensuite).
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { loadJourneesRattrapage } from "@/lib/rattrapage-journees.js";

const SAISON = "2099-2100";

const addRun = (stats: object | null, status = "success", startedAgoHours = 1) =>
  query(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status, stats, started_at)
     VALUES ('ffhandball.fr', 'matchs', $1, $2, $3::jsonb, now() - make_interval(hours => $4))`,
    [SAISON, status, stats ? JSON.stringify(stats) : null, startedAgoHours],
  );

beforeEach(async () => {
  await query(`DELETE FROM raw.scrape_runs WHERE saison = $1`, [SAISON]);
});

afterAll(async () => {
  await query(`DELETE FROM raw.scrape_runs WHERE saison = $1`, [SAISON]);
  await closePool();
});

describe("loadJourneesRattrapage", () => {
  it("null sans run en mode manquantes (un run « courante » sans stats est ignoré)", async () => {
    await addRun(null);
    expect(await loadJourneesRattrapage({ saison: SAISON })).toBeNull();
  });

  it("lit les compteurs du dernier run manquantes", async () => {
    await addRun({ mode: "manquantes", poules_concernees: 5, journees_recuperees: 12, journees_reportees: 3, journees_en_echec: 1, plafond: 2500 }, "success", 5);
    await addRun({ mode: "manquantes", poules_concernees: 9, journees_recuperees: 40, journees_reportees: 0, journees_en_echec: 0, plafond: 2500 }, "partial", 1);
    const r = await loadJourneesRattrapage({ saison: SAISON });
    expect(r).toMatchObject({ poules_concernees: 9, journees_recuperees: 40, journees_reportees: 0, journees_en_echec: 0, plafond: 2500 });
  });

  it("maxAgeHours écarte un run trop ancien", async () => {
    await addRun({ mode: "manquantes", journees_recuperees: 1 }, "success", 48);
    expect(await loadJourneesRattrapage({ saison: SAISON, maxAgeHours: 36 })).toBeNull();
    expect(await loadJourneesRattrapage({ saison: SAISON })).not.toBeNull();
  });
});

// ── Base vs site ──────────────────────────────────────────────────────────────────────────────
import { loadCouvertureJournees, recordSiteJournees } from "@/lib/rattrapage-journees.js";

describe("couverture base vs site", () => {
  const POULE = "TST-COUV-P";

  beforeEach(async () => {
    await query(`DELETE FROM raw.site_journees WHERE saison = $1`, [SAISON]);
    await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'TST-COUV-%'`);
    await query(`DELETE FROM core.competitions WHERE id_ffhb = 'TST-COUV-C'`); // cascade phases/poules
    await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'TST-COUV-%'`);
    await query(`INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1, '2099-07-01', '2100-06-30') ON CONFLICT DO NOTHING`, [SAISON]);
  });

  afterAll(async () => {
    await query(`DELETE FROM raw.site_journees WHERE saison = $1`, [SAISON]);
    await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'TST-COUV-%'`);
    await query(`DELETE FROM core.competitions WHERE id_ffhb = 'TST-COUV-C'`);
    await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'TST-COUV-%'`);
  });

  async function poule(): Promise<{ poule: number; dom: number; ext: number }> {
    const c = await query<{ id: number }>(`INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code) VALUES ('TST-COUV-C', 'CHAMPIONNAT TEST', 'departemental', $1) RETURNING id`, [SAISON]);
    const ph = await query<{ id: number }>(`INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code) VALUES ('TST-COUV-PH', $1, 'P', $2) RETURNING id`, [c.rows[0]!.id, SAISON]);
    const po = await query<{ id: number }>(`INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code) VALUES ($3, $1, 'POULE', $2) RETURNING id`, [ph.rows[0]!.id, SAISON, POULE]);
    const d = await query<{ id: number }>(`INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('TST-COUV-E1', 'A', $1) RETURNING id`, [SAISON]);
    const e = await query<{ id: number }>(`INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('TST-COUV-E2', 'B', $1) RETURNING id`, [SAISON]);
    return { poule: po.rows[0]!.id, dom: d.rows[0]!.id, ext: e.rows[0]!.id };
  }
  const match = (p: { poule: number; dom: number; ext: number }, key: string, journee: number, statut: string, daysAgo: number) =>
    query(
      `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, journee, date_heure, statut)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6), $7)`,
      [key, p.poule, p.dom, p.ext, journee, daysAgo, statut],
    );
  const ymd = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

  it("null tant que le site n'a pas été lu", async () => {
    expect(await loadCouvertureJournees(SAISON)).toBeNull();
  });

  it("compte les journées commencées sur le site, présentes ou non en base (futures ignorées)", async () => {
    const p = await poule();
    await recordSiteJournees(SAISON, POULE, [
      { numero: 1, date_debut: ymd(-30), date_fin: ymd(-29) }, // jouée, en base
      { numero: 2, date_debut: ymd(-20), date_fin: ymd(-19) }, // jouée, absente de la base
      { numero: 3, date_debut: ymd(-10), date_fin: ymd(-9) }, // en base mais match resté « à jouer » : à relire
      { numero: 4, date_debut: ymd(+10), date_fin: ymd(+11) }, // future : ignorée
    ]);
    await match(p, "TST-COUV-M1", 1, "joue", 30);
    await match(p, "TST-COUV-M3", 3, "a_jouer", 10);

    const c = (await loadCouvertureJournees(SAISON))!;
    expect(c).toMatchObject({ journees_site: 3, journees_en_base: 1, poules_site: 1, poules_incompletes: 1 });
    expect(c.top).toEqual([{ competition: "CHAMPIONNAT TEST", manquantes: 2 }]);
    expect(c.derniere_lecture).toBeInstanceOf(Date);
  });

  it("recordSiteJournees est idempotent (upsert)", async () => {
    const j = [{ numero: 1, date_debut: ymd(-5), date_fin: ymd(-4) }];
    await recordSiteJournees(SAISON, POULE, j);
    await recordSiteJournees(SAISON, POULE, j);
    expect((await query(`SELECT 1 FROM raw.site_journees WHERE saison = $1`, [SAISON])).rowCount).toBe(1);
  });
});
