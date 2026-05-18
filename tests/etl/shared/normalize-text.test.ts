import { describe, it, expect } from "vitest";
import { normalizeText, titleCaseFr } from "@/etl/shared/normalize-text.js";

describe("normalizeText", () => {
  it("trims whitespace", () => {
    expect(normalizeText("  hello  ")).toBe("hello");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeText("a   b\t\tc")).toBe("a b c");
  });

  it("normalizes to NFC", () => {
    const decomposed = "é"; // é
    const composed = "é";
    expect(normalizeText(decomposed)).toBe(composed);
  });

  it("strips zero-width and BOM", () => {
    expect(normalizeText("﻿hello​world")).toBe("helloworld");
  });

  it("returns empty string for nullish via wrapper", () => {
    expect(normalizeText("")).toBe("");
  });
});

describe("titleCaseFr", () => {
  it("title-cases simple names", () => {
    expect(titleCaseFr("jean dupont")).toBe("Jean Dupont");
  });

  it("keeps French particles lowercase", () => {
    expect(titleCaseFr("jean de la fontaine")).toBe("Jean de la Fontaine");
  });

  it("handles apostrophe particle", () => {
    expect(titleCaseFr("alice d'arc")).toBe("Alice d'Arc");
  });

  it("handles hyphenated names", () => {
    expect(titleCaseFr("jean-pierre dupont")).toBe("Jean-Pierre Dupont");
  });
});
