import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClubSlugs } from "@/scrapers/ffhandball/club-slugs.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

describe("parseClubSlugs", () => {
  it("extracts an array of unique slugs from the home page", () => {
    const html = fixture("monclub-home.html");
    const slugs = parseClubSlugs(html);
    expect(slugs.length).toBeGreaterThan(2000);
    // Slugs should be unique
    expect(slugs).toEqual([...new Set(slugs)]);
    // Slugs should be lowercase, dashed, alphanumeric only
    expect(slugs.every((s) => /^[a-z0-9-]+$/.test(s))).toBe(true);
    // Spot-check known slugs from T1
    expect(slugs).toContain("handball-club-de-vihiers");
    expect(slugs).toContain("3mt");
    expect(slugs).toContain("beach-handball-indre");
  });

  it("returns empty array when HTML has no slugs blob", () => {
    expect(parseClubSlugs("<html><body>nothing</body></html>")).toEqual([]);
  });
});
