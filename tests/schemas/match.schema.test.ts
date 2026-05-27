// tests/schemas/match.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawMatchPayloadSchema } from "@/schemas/match.schema.js";

describe("rawMatchPayloadSchema", () => {
  it("accepts a complete payload (match joué)", () => {
    const r = rawMatchPayloadSchema.safeParse({
      ext_rencontre_id: "2388869",
      ext_poule_id: "168256",
      ext_equipe_dom_id: "1949474",
      ext_equipe_ext_id: "1949475",
      date_heure: "2025-09-03T20:00:00+02:00",
      score_dom: 28,
      score_ext: 25,
      score_mt_dom: 14,
      score_mt_ext: 12,
      journee: 1,
      equipement_id: "2348",
      fdm_code: "VAGARIM",
      arbitre1_id: "350466",
      arbitre1_nom: "CHIFFOLEAU JULES",
      arbitre2_id: "350465",
      arbitre2_nom: "CHIFFOLEAU MAX",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/",
    });
    expect(r.success).toBe(true);
  });

  it("accepts payload with null scores (match à venir)", () => {
    const r = rawMatchPayloadSchema.safeParse({
      ext_rencontre_id: "X1",
      ext_poule_id: "P1",
      ext_equipe_dom_id: "E1",
      ext_equipe_ext_id: "E2",
      date_heure: "2026-05-27T20:00:00+02:00",
      score_dom: null,
      score_ext: null,
      journee: 25,
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("coerces score strings to numbers (source ffhandball.fr renvoie scores as strings)", () => {
    const r = rawMatchPayloadSchema.safeParse({
      ext_rencontre_id: "R1",
      ext_poule_id: "P1",
      ext_equipe_dom_id: "E1",
      ext_equipe_ext_id: "E2",
      date_heure: "2025-09-03T20:00:00+02:00",
      score_dom: "33",
      score_ext: "18",
      score_mt_dom: "15",
      score_mt_ext: "12",
      journee: "1",
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.score_dom).toBe(33);
      expect(r.data.score_ext).toBe(18);
      expect(r.data.score_mt_dom).toBe(15);
      expect(r.data.score_mt_ext).toBe(12);
      expect(r.data.journee).toBe(1);
    }
  });

  it("coerces journee from string to number", () => {
    const r = rawMatchPayloadSchema.safeParse({
      ext_rencontre_id: "X1",
      ext_poule_id: "P1",
      ext_equipe_dom_id: "E1",
      ext_equipe_ext_id: "E2",
      date_heure: "2026-05-27T20:00:00+02:00",
      journee: "25",
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.journee).toBe(25);
  });

  it("rejects invalid date_heure", () => {
    const r = rawMatchPayloadSchema.safeParse({
      ext_rencontre_id: "X1",
      ext_poule_id: "P1",
      ext_equipe_dom_id: "E1",
      ext_equipe_ext_id: "E2",
      date_heure: "not-a-date",
      journee: 1,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when ext_equipe_dom_id is missing", () => {
    const r = rawMatchPayloadSchema.safeParse({
      ext_rencontre_id: "X1",
      ext_poule_id: "P1",
      ext_equipe_ext_id: "E2",
      date_heure: "2026-05-27T20:00:00+02:00",
      journee: 1,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
