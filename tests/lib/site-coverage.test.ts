import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseAvailableTypes,
  sectionSegmentForType,
  parseCompetitionList,
} from "@/scrapers/ffhandball/competition-list.scraper.js";
import { evaluateSiteCoverage, loadSiteCoverage, MAX_COVERAGE_AGE_DAYS, type SiteCoverage } from "@/lib/site-coverage.js";
import { query, closePool } from "@/db/client.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

describe("découverte des sections du site", () => {
  it("lit les sections annoncées (available_types) sur la page Coupe de France de 2026-2027", () => {
    const types = parseAvailableTypes(fixture("ffhandball-competitions-coupe-de-france.html"));
    expect(types).toEqual(expect.arrayContaining(["NATIONAL", "REGIONAL", "DEPARTEMENTAL", "COUPE_DE_FRANCE"]));
  });

  it("renvoie [] si le menu est illisible (le scraper se rabat alors sur la Coupe de France)", () => {
    expect(parseAvailableTypes("<html><body>rien</body></html>")).toEqual([]);
  });

  it("segment d'URL : niveau pour les 3 historiques, kebab-case du type pour les autres", () => {
    expect(sectionSegmentForType("NATIONAL")).toBe("national");
    expect(sectionSegmentForType("REGIONAL")).toBe("regional");
    expect(sectionSegmentForType("DEPARTEMENTAL")).toBe("departemental");
    expect(sectionSegmentForType("COUPE_DE_FRANCE")).toBe("coupe-de-france");
    expect(sectionSegmentForType("INTER_LIGUES")).toBe("inter-ligues");
    expect(sectionSegmentForType("INTER_COMITES")).toBe("inter-comites");
  });

  it("un type de compétition INCONNU n'est plus ignoré en silence : classé national, URL sous sa propre section", () => {
    const attrs = JSON.stringify({
      competitions: [
        { ext_competitionId: "99001", libelle: "TOURNOI INTER REGIONS 2026-2027", type: "INTER_REGIONS", genre: "MASCULIN" },
      ],
      available_types: ["INTER_REGIONS"],
    }).replace(/"/g, "&quot;");
    const html = `<html><body><smartfire-component name="competitions---competition-main-menu" attributes="${attrs}"></smartfire-component></body></html>`;
    const list = parseCompetitionList(html, "national", "https://example.org/x/", "2026-2027", "22");
    expect(list).toHaveLength(1);
    expect(list[0]!.niveau).toBe("national");
    expect(list[0]!.detail_url).toBe(
      "https://www.ffhandball.fr/competitions/saison-2026-2027-22/inter-regions/tournoi-inter-regions-2026-2027-99001/",
    );
  });
});

describe("evaluateSiteCoverage (pur)", () => {
  const now = new Date("2026-10-15T07:00:00Z");
  const sain = (): SiteCoverage => ({
    runStartedAt: new Date("2026-10-15T02:00:00Z"),
    missingInCore: 0,
    rows: [
      { section: "national", announced: true, crawled: true, competitions: 12, note: null },
      { section: "regional", announced: true, crawled: true, competitions: 1000, note: null },
      { section: "coupe-de-france", announced: true, crawled: true, competitions: 8, note: null },
    ],
  });

  it("aucun problème quand tout est lu et à jour", () => {
    expect(evaluateSiteCoverage(sain(), now)).toEqual([]);
  });

  it("signale une section annoncée par le site mais non lue (le cas de la Coupe de France)", () => {
    const c = sain();
    c.rows[2] = { section: "coupe-de-france", announced: true, crawled: false, competitions: 0, note: "annoncée par le site mais non visitée" };
    const p = evaluateSiteCoverage(c, now);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("coupe-de-france");
    expect(p[0]).toContain("non visitée");
  });

  it("une section lue mais vide n'est PAS un problème (début de saison), une section à structures non gérée l'est", () => {
    const vide = sain();
    vide.rows.push({ section: "inter-ligues", announced: true, crawled: true, competitions: 0, note: "aucune compétition lue" });
    expect(evaluateSiteCoverage(vide, now)).toEqual([]);

    const structures = sain();
    structures.rows.push({ section: "inter-comites", announced: true, crawled: true, competitions: 0, note: "STRUCTURES : 12 structure(s), section non gérée" });
    const p = evaluateSiteCoverage(structures, now);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("inter-comites");
    expect(p[0]).toContain("12 structure(s)");
  });

  it("signale des compétitions vues sur le site mais absentes de la base", () => {
    const c = sain();
    c.missingInCore = 7;
    expect(evaluateSiteCoverage(c, now)[0]).toContain("7 compétition(s)");
  });

  it(`signale une structure non relue depuis plus de ${MAX_COVERAGE_AGE_DAYS} jours`, () => {
    const c = sain();
    c.runStartedAt = new Date("2026-10-09T02:00:00Z");
    expect(evaluateSiteCoverage(c, now).join(" ")).toContain("n'a pas été relue depuis 6 jours");
  });
});

// Intégration : base de test requise.
describe("loadSiteCoverage", () => {
  const SAISON = "2099-2100";

  beforeEach(async () => {
    await query(`DELETE FROM raw.competitions WHERE saison = $1`, [SAISON]);
    await query(`DELETE FROM raw.scrape_runs WHERE saison = $1`, [SAISON]);
    await query(`DELETE FROM core.competitions WHERE saison_code = $1`, [SAISON]);
    await query(
      `INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1, '2099-07-01', '2100-06-30') ON CONFLICT DO NOTHING`,
      [SAISON],
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM raw.competitions WHERE saison = $1`, [SAISON]);
    await query(`DELETE FROM raw.scrape_runs WHERE saison = $1`, [SAISON]);
    await query(`DELETE FROM core.competitions WHERE saison_code = $1`, [SAISON]);
    await closePool();
  });

  it("null quand aucun scrape n'a journalisé ses sections", async () => {
    expect(await loadSiteCoverage(SAISON)).toBeNull();
  });

  it("lit les sections du dernier run et compte les compétitions absentes de core", async () => {
    const run = await query<{ id: string }>(
      `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status) VALUES ('ffhandball.fr', 'competitions', $1, 'success') RETURNING id`,
      [SAISON],
    );
    const id = run.rows[0]!.id;
    await query(
      `INSERT INTO raw.site_sections (scrape_run_id, saison, section, announced, crawled, competitions, note)
       VALUES ($1, $2, 'national', true, true, 2, NULL), ($1, $2, 'coupe-de-france', true, false, 0, 'page injoignable')`,
      [id, SAISON],
    );
    // 2 compétitions vues sur le site ; une seule est en base.
    for (const ext of ["T1", "T2"]) {
      await insertRaw("competitions", {
        scrape_run_id: id,
        source_url: "https://example.org/",
        source_site: "ffhandball.fr",
        natural_key: ext,
        payload: { ext_competition_id: ext },
        saison: SAISON,
        http_status: 200,
      });
    }
    await query(`INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code) VALUES ('T1', 'T1', 'national', $1)`, [SAISON]);

    const cov = await loadSiteCoverage(SAISON);
    expect(cov).not.toBeNull();
    expect(cov!.rows.map((r) => r.section)).toEqual(["coupe-de-france", "national"]);
    expect(cov!.missingInCore).toBe(1);
    const problems = evaluateSiteCoverage(cov!);
    expect(problems.some((p) => p.includes("coupe-de-france") && p.includes("page injoignable"))).toBe(true);
    expect(problems.some((p) => p.includes("1 compétition(s)"))).toBe(true);
  });
});
