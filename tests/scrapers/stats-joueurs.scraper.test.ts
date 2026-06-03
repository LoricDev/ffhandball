// tests/scrapers/stats-joueurs.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseStatsJoueurs } from "@/scrapers/ffhandball/stats-joueurs.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/statistiques/";
const EXT_POULE_ID = "168256";

describe("parseStatsJoueurs", () => {
  it("extracts 287 stats from LBE fixture", () => {
    const html = fixture("ffhandball-poule-stats-lbe.html");
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    expect(r.length).toBe(287);

    // Meilleur buteur ANTONISSEN
    const top = r.find((s) => s.nom === "ANTONISSEN");
    expect(top).toBeDefined();
    expect(top!.prenom).toBe("NELE");
    expect(top!.total_buts).toBe(195);
    expect(top!.match_count).toBe(25);
    expect(top!.equipe_libelle).toBe("HANDBALL PLAN DE CUQUES");
    expect(top!.ext_poule_id).toBe(EXT_POULE_ID);
    // ext_equipe_id résolu depuis equipe_options de la poule (résolution par id côté ETL)
    expect(top!.ext_equipe_id).toMatch(/^\d+$/);
    // toutes les lignes ont un ext_equipe_id (les 14 équipes sont dans equipe_options)
    expect(r.every((s) => typeof s.ext_equipe_id === "string" && /^\d+$/.test(s.ext_equipe_id))).toBe(true);

    // Tous les ext_poule_id pointent vers la bonne poule
    expect(r.every((s) => s.ext_poule_id === EXT_POULE_ID)).toBe(true);

    // Coercion strings → numbers vérifiée
    for (const s of r) {
      expect(typeof s.match_count).toBe("number");
      expect(typeof s.total_buts).toBe("number");
      expect(typeof s.total_arrets).toBe("number");
    }
  });

  it("returns [] on soft-404 (is404=true in page-header)", () => {
    const html = `<smartfire-component name='competitions---page-header' attributes='${JSON.stringify(
      { is404: true, title: "Page not found - FFHandball" },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    expect(parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID)).toEqual([]);
  });

  it("returns [] when stats-joueurs component is absent", () => {
    const html = `<smartfire-component name='competitions---page-header' attributes='${JSON.stringify(
      { is404: false },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    expect(parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID)).toEqual([]);
  });

  it("returns [] when rowsData is empty", () => {
    const html = `<smartfire-component name='competitions---stats-joueurs' attributes='${JSON.stringify(
      { rowsData: [] },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    expect(parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID)).toEqual([]);
  });

  it("skips lignes where required fields are missing", () => {
    const html = `<smartfire-component name='competitions---stats-joueurs' attributes='${JSON.stringify(
      {
        rowsData: [
          { individuId: "I1", nom: "OK", prenom: "User", equipeLibelle: "E", matchCount: "5", totalButs: "10", totalArrets: "0" },
          { individuId: "I2", nom: "", prenom: "Missing", equipeLibelle: "E", matchCount: "1", totalButs: "0", totalArrets: "0" }, // nom vide
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    expect(r.length).toBe(1);
    expect(r[0]!.individu_id).toBe("I1");
  });

  it("extracts ~278 stats from N3F AURA régional fixture", () => {
    const html = fixture("ffhandball-poule-stats-n3f-ara.html");
    const SOURCE_REGIONAL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/regional/nationale-3-feminine-aura-27879/poule-168406/statistiques/";
    const EXT_POULE_REGIONAL = "168406";
    const r = parseStatsJoueurs(html, SOURCE_REGIONAL, EXT_POULE_REGIONAL);
    expect(r.length).toBe(278);
    expect(r.every((s) => s.ext_poule_id === EXT_POULE_REGIONAL)).toBe(true);
    for (const s of r) {
      expect(typeof s.match_count).toBe("number");
      expect(typeof s.total_buts).toBe("number");
      expect(typeof s.total_arrets).toBe("number");
    }
  });
});
