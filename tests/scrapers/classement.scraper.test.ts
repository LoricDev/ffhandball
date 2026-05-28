// tests/scrapers/classement.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClassement } from "@/scrapers/ffhandball/classement.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/classements/";
const EXT_POULE_ID = "168256";

describe("parseClassement", () => {
  it("extracts 14 lignes from LBE fixture", () => {
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(14);

    // Position 1 doit exister et être valide
    const premier = r!.find((c) => c.position === 1);
    expect(premier).toBeDefined();
    expect(premier!.ext_equipe_id).toMatch(/^\d+$/);
    expect(premier!.points).toBeGreaterThan(0);
    expect(premier!.joues).toBeGreaterThan(0);

    // dernieres_rencontres devrait être présent
    expect(premier!.dernieres_rencontres).toBeDefined();
    expect(premier!.dernieres_rencontres).toMatch(/^[-0-9;]+$/);

    // Tous les classements pointent vers la bonne poule
    expect(r!.every((c) => c.ext_poule_id === EXT_POULE_ID)).toBe(true);
  });

  it("resolves equipeId interne → ext_equipe_id via equipe_options", () => {
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    for (const c of r!) {
      expect(c.ext_equipe_id).toMatch(/^\d+$/);
      expect(Number(c.ext_equipe_id)).toBeGreaterThan(100000);
    }
  });

  it("returns null when poule-selector is absent", () => {
    expect(parseClassement("<html></html>", SOURCE_URL, EXT_POULE_ID)).toBeNull();
  });

  it("returns [] when classement component is absent but poule-selector present (compétition sans matchs joués)", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "1000001" }],
        poules: [{ ext_pouleId: EXT_POULE_ID }],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).toEqual([]);
  });

  it("returns [] when classements array is empty", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "1000001" }],
        poules: [{ ext_pouleId: EXT_POULE_ID }],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>
    <smartfire-component name='competitions---classement' attributes='${JSON.stringify(
      { classements: [] },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).toEqual([]);
  });

  it("skips lignes whose equipeId is not in equipe_options", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "1000001" }],   // only equipe id=1
        poules: [{ ext_pouleId: EXT_POULE_ID }],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>
    <smartfire-component name='competitions---classement' attributes='${JSON.stringify(
      {
        classements: [
          { ext_classementId: "C1", pouleId: "X", equipeId: "1", place: "1", point: "10", joue: "5", gagne: "3", nul: "1", perdu: "1", butPlus: "100", butMoins: "80" },
          { ext_classementId: "C2", pouleId: "X", equipeId: "GHOST", place: "2", point: "8", joue: "5", gagne: "2", nul: "2", perdu: "1", butPlus: "90", butMoins: "85" },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(1);
    expect(r!.length > 0 && r![0]!.ext_classement_id).toBe("C1");
  });
});
