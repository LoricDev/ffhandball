// tests/scrapers/competition-detail.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL_MONO =
  "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/";

describe("parseCompetitionDetail", () => {
  it("extracts 1 phase + 1 poule for mono-poule competition (LBE)", () => {
    const html = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(html, SOURCE_URL_MONO, "28227");
    expect(r).not.toBeNull();
    expect(r!.phases).toHaveLength(1);
    expect(r!.phases[0]!.ext_competition_id).toBe("28227");
    expect(r!.poules).toHaveLength(1);
    expect(r!.poules[0]!.ext_phase_id).toBe(r!.phases[0]!.ext_phase_id);
    expect(r!.poules[0]!.nom).toMatch(/POULE/i);
  });

  it("propagates ext_phase_id correctly on multi-poules competition", () => {
    const html = fixture("ffhandball-competition-detail-multi-poules.html");
    const r = parseCompetitionDetail(html, "https://x/", "9999");
    expect(r).not.toBeNull();
    expect(r!.poules.length).toBeGreaterThan(1);
    // Chaque poule doit pointer vers un ext_phase_id présent dans phases
    const phaseIds = new Set(r!.phases.map((p) => p.ext_phase_id));
    for (const p of r!.poules) {
      expect(phaseIds.has(p.ext_phase_id)).toBe(true);
    }
  });

  it("returns null when poule-selector is absent", () => {
    expect(parseCompetitionDetail("<html></html>", "https://x/", "1")).toBeNull();
  });

  it("returns null when attributes JSON is malformed", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='{not json'></smartfire-component>`;
    expect(parseCompetitionDetail(html, "https://x/", "1")).toBeNull();
  });

  it("skips poules whose phaseId has no matching phase (orphan)", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        phases: [{ id: "P1", ext_phaseId: "EP1", libelle: "phase A" }],
        poules: [
          { id: "PO1", ext_pouleId: "EPO1", phaseId: "P1", libelle: "ok" },
          { id: "PO2", ext_pouleId: "EPO2", phaseId: "GHOST", libelle: "orphan" },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseCompetitionDetail(html, "https://x/", "C1");
    expect(r).not.toBeNull();
    expect(r!.phases).toHaveLength(1);
    expect(r!.poules).toHaveLength(1);
    expect(r!.poules[0]!.ext_poule_id).toBe("EPO1");
  });
});
