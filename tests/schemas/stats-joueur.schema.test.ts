// tests/schemas/stats-joueur.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawStatsJoueurPayloadSchema } from "@/schemas/stats-joueur.schema.js";

describe("rawStatsJoueurPayloadSchema", () => {
  it("accepts a complete payload with strings (source format)", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "168256",
      individu_id: "3098815",
      nom: "ANTONISSEN",
      prenom: "NELE",
      equipe_libelle: "HANDBALL PLAN DE CUQUES",
      match_count: "25",
      total_buts: "195",
      total_arrets: "0",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/statistiques/",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.match_count).toBe(25);
      expect(r.data.total_buts).toBe(195);
      expect(r.data.total_arrets).toBe(0);
    }
  });

  it("accepts payload with numbers directly", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "I",
      nom: "N",
      prenom: "P",
      equipe_libelle: "E",
      match_count: 5,
      total_buts: 30,
      total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty individu_id", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "",
      nom: "N", prenom: "P", equipe_libelle: "E",
      match_count: 0, total_buts: 0, total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty equipe_libelle", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "I",
      nom: "N", prenom: "P", equipe_libelle: "",
      match_count: 0, total_buts: 0, total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when match_count is malformed (non-numeric)", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "I",
      nom: "N", prenom: "P", equipe_libelle: "E",
      match_count: "abc",
      total_buts: 0, total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
