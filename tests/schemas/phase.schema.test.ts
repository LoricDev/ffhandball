// tests/schemas/phase.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawPhasePayloadSchema } from "@/schemas/phase.schema.js";

describe("rawPhasePayloadSchema", () => {
  it("accepts a valid phase payload", () => {
    const r = rawPhasePayloadSchema.safeParse({
      ext_phase_id: "96749",
      ext_competition_id: "28227",
      nom: "LIGUE BUTAGAZ ENERGIE",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when ext_competition_id is missing", () => {
    const r = rawPhasePayloadSchema.safeParse({
      ext_phase_id: "96749",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when ext_phase_id is empty", () => {
    const r = rawPhasePayloadSchema.safeParse({
      ext_phase_id: "",
      ext_competition_id: "28227",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
