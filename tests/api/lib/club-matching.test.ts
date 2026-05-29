// tests/api/lib/club-matching.test.ts
import { describe, it, expect } from "vitest";
import {
  extractDistinctiveTokens,
  buildWholeWordPattern,
  rankToConfidence,
  STOPWORDS,
} from "@/api/lib/club-matching.js";

describe("extractDistinctiveTokens", () => {
  it("garde les tokens distinctifs et exclut les mots génériques", () => {
    expect(extractDistinctiveTokens("BREST BRETAGNE HANDBALL")).toEqual(["brest", "bretagne"]);
  });

  it("exclut les tokens < 4 caractères et purement numériques", () => {
    // "HB" (2), "92" (numérique) exclus ; "PARIS" gardé
    expect(extractDistinctiveTokens("PARIS 92 HB")).toEqual(["paris"]);
  });

  it("normalise les accents et la casse", () => {
    expect(extractDistinctiveTokens("Étoile Sportive Vénissieux")).toEqual(["venissieux"]);
  });

  it("déduplique", () => {
    expect(extractDistinctiveTokens("NANTES NANTES CLUB")).toEqual(["nantes"]);
  });

  it("retourne [] si aucun token distinctif", () => {
    expect(extractDistinctiveTokens("CLUB HANDBALL")).toEqual([]);
  });

  it("STOPWORDS contient les mots structurels clés", () => {
    expect(STOPWORDS.has("handball")).toBe(true);
    expect(STOPWORDS.has("club")).toBe(true);
    expect(STOPWORDS.has("entente")).toBe(true);
  });
});

describe("buildWholeWordPattern", () => {
  it("construit un motif regex mot-entier", () => {
    expect(buildWholeWordPattern(["brest", "bretagne"])).toBe("\\m(brest|bretagne)\\M");
  });
  it("retourne null si pas de token", () => {
    expect(buildWholeWordPattern([])).toBeNull();
  });
});

describe("rankToConfidence", () => {
  it("mappe les rangs", () => {
    expect(rankToConfidence(3)).toBe("haute");
    expect(rankToConfidence(2)).toBe("moyenne");
    expect(rankToConfidence(1)).toBe("basse");
  });
});
