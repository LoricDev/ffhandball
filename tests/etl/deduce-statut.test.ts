import { describe, it, expect } from "vitest";
import { deduceStatut } from "@/etl/shared/deduce-statut.js";

describe("deduceStatut", () => {
  it("deux scores → joue (y compris 0)", () => {
    expect(deduceStatut(33, 18)).toBe("joue");
    expect(deduceStatut(20, 0)).toBe("joue");
  });
  it("un seul score 10 ou 20 → forfait (domicile ou extérieur)", () => {
    expect(deduceStatut(null, 20)).toBe("forfait");
    expect(deduceStatut(10, null)).toBe("forfait");
    expect(deduceStatut(undefined, 10)).toBe("forfait");
  });
  it("aucun score → a_jouer", () => {
    expect(deduceStatut(null, null)).toBe("a_jouer");
    expect(deduceStatut(undefined, undefined)).toBe("a_jouer");
  });
  it("score isolé atypique → a_jouer (resté visible dans le monitor)", () => {
    expect(deduceStatut(7, null)).toBe("a_jouer");
    expect(deduceStatut(null, 1)).toBe("a_jouer");
  });
});
