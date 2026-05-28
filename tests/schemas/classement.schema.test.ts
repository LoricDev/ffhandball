// tests/schemas/classement.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawClassementPayloadSchema } from "@/schemas/classement.schema.js";

describe("rawClassementPayloadSchema", () => {
  it("accepts a complete payload with strings (source format)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "59679118",
      ext_poule_id: "168256",
      ext_equipe_id: "1949474",
      position: "1",
      points: "73",
      joues: "25",
      gagnes: "24",
      nuls: "0",
      perdus: "1",
      buts_pour: "849",
      buts_contre: "603",
      dernieres_rencontres: "-1;1;1;1;1",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/classements/",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.position).toBe(1);
      expect(r.data.points).toBe(73);
      expect(r.data.joues).toBe(25);
      expect(r.data.buts_pour).toBe(849);
    }
  });

  it("accepts payload with numbers directly (numeric input)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "X",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: 1,
      points: 0,
      joues: 0,
      gagnes: 0,
      nuls: 0,
      perdus: 0,
      buts_pour: 0,
      buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("accepts payload without dernieres_rencontres (optional)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "X",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: 1,
      points: 0,
      joues: 0,
      gagnes: 0,
      nuls: 0,
      perdus: 0,
      buts_pour: 0,
      buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty ext_classement_id", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: 1,
      points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
      buts_pour: 0, buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when position is malformed (non-numeric string)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "X",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: "abc",
      points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
      buts_pour: 0, buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
