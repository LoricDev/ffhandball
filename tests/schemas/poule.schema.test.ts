// tests/schemas/poule.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawPoulePayloadSchema } from "@/schemas/poule.schema.js";

describe("rawPoulePayloadSchema", () => {
  it("accepts a valid poule payload", () => {
    const r = rawPoulePayloadSchema.safeParse({
      ext_poule_id: "168256",
      ext_phase_id: "96749",
      nom: "POULE UNIQUE",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when ext_phase_id is missing", () => {
    const r = rawPoulePayloadSchema.safeParse({
      ext_poule_id: "1",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
