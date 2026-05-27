// tests/etl/shared/split-nom-complet.test.ts
import { describe, it, expect } from "vitest";
import { splitNomComplet } from "@/etl/shared/split-nom-complet.js";

describe("splitNomComplet", () => {
  it("splits 2-word name into nom + prenom (convention FFHB)", () => {
    expect(splitNomComplet("CHAMI MILOUD")).toEqual({ nom: "CHAMI", prenom: "MILOUD" });
  });

  it("returns prenom=null when single word", () => {
    expect(splitNomComplet("TOTO")).toEqual({ nom: "TOTO", prenom: null });
  });

  it("joins remaining words as prenom (3+ words)", () => {
    expect(splitNomComplet("JEAN-PIERRE DUPOND MARTIN")).toEqual({
      nom: "JEAN-PIERRE",
      prenom: "DUPOND MARTIN",
    });
  });

  it("normalizes multiple spaces", () => {
    expect(splitNomComplet("  CHAMI    MILOUD  ")).toEqual({ nom: "CHAMI", prenom: "MILOUD" });
  });

  it("throws on empty string", () => {
    expect(() => splitNomComplet("")).toThrow();
    expect(() => splitNomComplet("   ")).toThrow();
  });
});
