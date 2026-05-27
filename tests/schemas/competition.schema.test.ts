// tests/schemas/competition.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawCompetitionPayloadSchema } from "@/schemas/competition.schema.js";

describe("rawCompetitionPayloadSchema", () => {
  it("accepts a valid national competition payload", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "28227",
      nom: "LIGUE BUTAGAZ ENERGIE 2025-26",
      niveau: "national",
      sexe: "F",
      code: "001",
      ext_structure_id: "1",
      detail_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/",
    });
    expect(r.success).toBe(true);
  });

  it("accepts payload without optional fields", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "9999",
      nom: "X",
      niveau: "regional",
      detail_url: "https://www.ffhandball.fr/x/",
      source_url: "https://www.ffhandball.fr/y/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid niveau", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "1",
      nom: "X",
      niveau: "international",
      detail_url: "https://www.ffhandball.fr/",
      source_url: "https://www.ffhandball.fr/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty ext_competition_id", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "",
      nom: "X",
      niveau: "national",
      detail_url: "https://x/",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
