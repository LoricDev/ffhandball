import { describe, it, expect } from "vitest";
import { rawEquipePayloadSchema } from "@/schemas/equipe.schema.js";

describe("rawEquipePayloadSchema", () => {
  it("accepts a complete payload", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      nom: "BREST BRETAGNE HANDBALL",
      ext_structure_id: "1720",
      logo: "2023-06-13-aaa.jpg",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
    });
    expect(r.success).toBe(true);
  });

  it("accepts payload without optional fields (fallback case)", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty ext_equipe_id", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing nom", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "1",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
