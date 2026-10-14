import { describe, it, expect } from "vitest";
import { deduceForfait, deduceStatut } from "@/etl/shared/deduce-statut.js";

describe("deduceStatut / deduceForfait", () => {
  it("deux scores → joue (y compris 0)", () => {
    expect(deduceStatut({ score_dom: 33, score_ext: 18 })).toBe("joue");
    expect(deduceStatut({ score_dom: 20, score_ext: 0 })).toBe("joue");
    expect(deduceForfait({ score_dom: 20, score_ext: 0 })).toBeNull();
  });
  it("marqueur FO explicite → forfait + côté", () => {
    expect(deduceForfait({ forfait_dom: true, score_ext: 20 })).toBe("dom");
    expect(deduceForfait({ forfait_ext: true, score_dom: 10 })).toBe("ext");
    expect(deduceStatut({ forfait_ext: true })).toBe("forfait"); // même sans score de l'adversaire
    expect(deduceStatut({ forfait_dom: true, forfait_ext: true })).toBe("forfait");
  });
  it("repli (anciennes captures) : score isolé 10/20 → forfait de l'équipe sans score", () => {
    expect(deduceForfait({ score_dom: null, score_ext: 20 })).toBe("dom");
    expect(deduceForfait({ score_dom: 10, score_ext: null })).toBe("ext");
    expect(deduceStatut({ score_dom: undefined, score_ext: 10 })).toBe("forfait");
  });
  it("aucun score → a_jouer", () => {
    expect(deduceStatut({})).toBe("a_jouer");
    expect(deduceStatut({ score_dom: null, score_ext: null })).toBe("a_jouer");
  });
  it("score isolé atypique → a_jouer (reste visible dans le monitor)", () => {
    expect(deduceStatut({ score_dom: 7, score_ext: null })).toBe("a_jouer");
    expect(deduceStatut({ score_dom: null, score_ext: 1 })).toBe("a_jouer");
  });
});
