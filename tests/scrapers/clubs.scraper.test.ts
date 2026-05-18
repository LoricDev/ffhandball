import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/ffhandball-clubs-listing.html", import.meta.url),
);

describe("parseClubsListing", () => {
  it("extracts clubs from listing HTML", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const baseUrl = "https://www.ffhandball.fr/clubs";
    const result = parseClubsListing(html, baseUrl);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id_ffhb: "6275001",
      nom: "HBC Trifouilly-sur-Mer",
      ville: "Trifouilly",
      departement_code: "75",
      source_url: baseUrl,
    });
    expect(result[1]?.departement_code).toBe("2A");
  });

  it("returns empty array on empty HTML", () => {
    expect(parseClubsListing("<html></html>", "https://x.test")).toEqual([]);
  });
});
