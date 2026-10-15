import { describe, it, expect } from "vitest";
import { journeesToFetch } from "@/scrapers/shared/journees.js";
import type { JourneeInfo } from "@/scrapers/ffhandball/rencontre-list.scraper.js";

// Poule 2DTM : J1..J4 en septembre/début octobre, J5 le 7 novembre (courante), J6 plus tard.
const J = (numero: number, debut: string | null, fin: string | null = debut): JourneeInfo => ({ numero, date_debut: debut, date_fin: fin }) as JourneeInfo;
const journees = [J(1, "2026-09-12", "2026-09-13"), J(2, "2026-09-19", "2026-09-20"), J(3, "2026-09-26", "2026-09-27"), J(4, "2026-10-03", "2026-10-04"), J(5, "2026-11-07", "2026-11-08"), J(6, "2026-11-14", "2026-11-15")];
const now = new Date("2026-10-15T07:00:00");
const o = { recentDays: 14 };

describe("journeesToFetch", () => {
  it("courante : rien en plus", () => {
    expect(journeesToFetch("courante", journees, 5, now, o)).toEqual([]);
  });

  it("all : toutes les journées commencées, sauf la courante et les futures", () => {
    expect(journeesToFetch("all", journees, 5, now, o)).toEqual([1, 2, 3, 4]);
  });

  it("recent : seulement la fenêtre glissante (J4 finie il y a 11 jours)", () => {
    expect(journeesToFetch("recent", journees, 5, now, o)).toEqual([4]);
  });

  it("manquantes : ce que la base n'a pas encore, jamais le futur ni la courante", () => {
    expect(journeesToFetch("manquantes", journees, 5, now, { ...o, completes: new Set() })).toEqual([1, 2, 3, 4]);
    expect(journeesToFetch("manquantes", journees, 5, now, { ...o, completes: new Set([1, 2, 3]) })).toEqual([4]);
  });

  it("manquantes : tout est complet → rien à télécharger (régime nominal)", () => {
    expect(journeesToFetch("manquantes", journees, 5, now, { ...o, completes: new Set([1, 2, 3, 4]) })).toEqual([]);
  });

  it("manquantes : une journée sans date exploitable est ignorée", () => {
    expect(journeesToFetch("manquantes", [J(1, null)], undefined, now, { ...o, completes: new Set() })).toEqual([]);
  });
});
