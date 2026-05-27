// tests/scrapers/competition-list.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseCompetitionList,
  parseStructures,
} from "@/scrapers/ffhandball/competition-list.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/";
const EXT_SAISON_ID = "21";

describe("parseCompetitionList — national", () => {
  it("extracts the 20 national competitions", () => {
    const html = fixture("ffhandball-competitions-national.html");
    const list = parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID);
    expect(list.length).toBeGreaterThanOrEqual(15);
    expect(list.length).toBeLessThanOrEqual(40);
  });

  it("maps genre → sexe and type → niveau correctly", () => {
    const html = fixture("ffhandball-competitions-national.html");
    const list = parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID);
    const lbe = list.find((c) => c.ext_competition_id === "28227");
    expect(lbe).toBeDefined();
    expect(lbe!.niveau).toBe("national");
    expect(lbe!.sexe).toBe("F"); // FEMININ
    expect(lbe!.nom).toMatch(/LIGUE BUTAGAZ/i);
    expect(lbe!.detail_url).toMatch(/^https:\/\/www\.ffhandball\.fr\/competitions\/saison-2025-2026-21\/national\/.*-28227\/$/);
  });

  it("returns [] when smartfire-component is absent", () => {
    expect(
      parseCompetitionList("<html><body>nothing</body></html>", "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID),
    ).toEqual([]);
  });

  it("returns [] when attributes JSON is malformed", () => {
    const html = `<smartfire-component name='competitions---competition-main-menu' attributes='{not json'></smartfire-component>`;
    expect(parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID)).toEqual([]);
  });

  it("deduplicates by ext_competition_id", () => {
    const html = fixture("ffhandball-competitions-national.html");
    const list = parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID);
    const ids = list.map((c) => c.ext_competition_id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe("parseStructures", () => {
  it("returns [] on national page", () => {
    const html = fixture("ffhandball-competitions-national.html");
    expect(parseStructures(html)).toEqual([]);
  });
});
