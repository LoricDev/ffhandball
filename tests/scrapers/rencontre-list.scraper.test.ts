// tests/scrapers/rencontre-list.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRencontreList } from "@/scrapers/ffhandball/rencontre-list.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/";
const EXT_POULE_ID = "168256";

describe("parseRencontreList", () => {
  it("extracts matchs from journée 1 fixture (with scores)", () => {
    const html = fixture("ffhandball-poule-rencontres-journee-1.html");
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.matchs.length).toBeGreaterThan(0);
    expect(r!.journees_disponibles.length).toBeGreaterThan(20); // LBE = 26 journées

    // Au moins un match a des scores
    const withScores = r!.matchs.filter((m) => m.score_dom !== null && m.score_ext !== null);
    expect(withScores.length).toBeGreaterThan(0);

    // Tous les matchs pointent vers la bonne poule
    expect(r!.matchs.every((m) => m.ext_poule_id === EXT_POULE_ID)).toBe(true);
  });

  it("capture les équipes + engagements de la poule (couverture complète)", () => {
    const html = fixture("ffhandball-poule-rencontres-journee-1.html");
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    // equipe_options de la poule = 14 équipes (LBE)
    expect(r!.equipes.length).toBe(14);
    expect(r!.equipes.every((e) => /^\d+$/.test(e.ext_equipe_id) && e.nom.length > 0)).toBe(true);
    // toute équipe référencée par un match est présente dans les équipes capturées
    const eqIds = new Set(r!.equipes.map((e) => e.ext_equipe_id));
    for (const m of r!.matchs) {
      expect(eqIds.has(m.ext_equipe_dom_id)).toBe(true);
      expect(eqIds.has(m.ext_equipe_ext_id)).toBe(true);
    }
    // engagements liés à la poule scrapée
    expect(r!.engagements.length).toBe(14);
    expect(r!.engagements.every((en) => en.ext_poule_id === EXT_POULE_ID)).toBe(true);
  });

  it("extracts matchs from journée en cours fixture", () => {
    const html = fixture("ffhandball-poule-rencontres-journee-en-cours.html");
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.matchs.length).toBeGreaterThan(0);
  });

  it("resolves equipe1Id/equipe2Id via equipe_options to ext_equipe_id format", () => {
    const html = fixture("ffhandball-poule-rencontres-journee-1.html");
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    // Les ext_equipe_dom_id/ext sont des chiffres FFHB (typiquement 6-7 chiffres, > 100000)
    for (const m of r!.matchs) {
      expect(m.ext_equipe_dom_id).toMatch(/^\d+$/);
      expect(m.ext_equipe_ext_id).toMatch(/^\d+$/);
      expect(Number(m.ext_equipe_dom_id)).toBeGreaterThan(100000);
      expect(Number(m.ext_equipe_ext_id)).toBeGreaterThan(100000);
      expect(m.ext_equipe_dom_id).not.toBe(m.ext_equipe_ext_id);
    }
  });

  it("returns null when poule-selector is absent", () => {
    expect(parseRencontreList("<html></html>", SOURCE_URL, EXT_POULE_ID)).toBeNull();
  });

  it("returns empty matchs but populated journees when rencontre-list is absent", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "E1" }],
        poules: [{ ext_pouleId: EXT_POULE_ID, journees: JSON.stringify([{ journee_numero: 1, date_debut: "2025-09-03" }, { journee_numero: 2, date_debut: "2025-09-10" }]) }],
        selected_poule: { ext_pouleId: EXT_POULE_ID, journees: JSON.stringify([{ journee_numero: 1, date_debut: "2025-09-03" }, { journee_numero: 2, date_debut: "2025-09-10" }]) },
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.matchs).toEqual([]);
    expect(r!.journees_disponibles).toEqual([1, 2]);
  });

  it("skips rencontres whose extPouleId does not match", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [
          { id: "1", ext_equipeId: "1000001" },
          { id: "2", ext_equipeId: "1000002" },
        ],
        poules: [{ ext_pouleId: EXT_POULE_ID, journees: "[]" }],
        selected_poule: { ext_pouleId: EXT_POULE_ID, journees: "[]" },
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>
    <smartfire-component name='competitions---rencontre-list' attributes='${JSON.stringify(
      {
        rencontres: [
          { ext_rencontreId: "R1", extPouleId: EXT_POULE_ID, equipe1Id: "1", equipe2Id: "2", equipe1Score: null, equipe2Score: null, date: "2026-05-27T20:00:00+02:00", journeeNumero: "1", equipementId: "X" },
          { ext_rencontreId: "R2", extPouleId: "OTHER", equipe1Id: "1", equipe2Id: "2", equipe1Score: null, equipe2Score: null, date: "2026-05-27T20:00:00+02:00", journeeNumero: "1", equipementId: "X" },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.matchs.length).toBe(1);
    expect(r!.matchs[0]!.ext_rencontre_id).toBe("R1");
  });

  it("skips rencontres whose equipe is not in equipe_options", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "1000001" }],  // only equipe id=1
        poules: [{ ext_pouleId: EXT_POULE_ID, journees: "[]" }],
        selected_poule: { ext_pouleId: EXT_POULE_ID, journees: "[]" },
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>
    <smartfire-component name='competitions---rencontre-list' attributes='${JSON.stringify(
      {
        rencontres: [
          { ext_rencontreId: "R1", extPouleId: EXT_POULE_ID, equipe1Id: "1", equipe2Id: "GHOST", equipe1Score: null, equipe2Score: null, date: "2026-05-27T20:00:00+02:00", journeeNumero: "1" },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseRencontreList(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.matchs).toEqual([]);
  });
});
