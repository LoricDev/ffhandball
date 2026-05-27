import * as cheerio from "cheerio";

/**
 * Extracts club slugs from the monclub.ffhandball.fr home page.
 *
 * Source: `<smartfire-component name='home-hero'>` carries a JSON blob in its
 * `attributes` attribute (HTML-escaped via `&quot;`). Inside the JSON, the
 * key path is `geojson.features[].properties.url`, where each `url` looks like
 * `https://monclub.ffhandball.fr/clubs/<slug>/`.
 *
 * Returns a deduplicated, sorted array of slug strings. Returns an empty array
 * if the component is absent or the JSON cannot be parsed.
 */
export function parseClubSlugs(html: string): string[] {
  const $ = cheerio.load(html);
  const el = $("smartfire-component[name='home-hero']").first();
  const raw = el.attr("attributes");
  if (!raw) return [];

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const geojson = (data as { geojson?: unknown }).geojson;
  const features =
    geojson && typeof geojson === "object"
      ? (geojson as { features?: unknown }).features
      : undefined;
  if (!Array.isArray(features)) return [];

  const slugRe = /^https?:\/\/monclub\.ffhandball\.fr\/clubs\/([a-z0-9-]+)\/?$/;
  const slugs = new Set<string>();
  for (const f of features) {
    const url = (f as { properties?: { url?: unknown } }).properties?.url;
    if (typeof url !== "string") continue;
    const m = slugRe.exec(url);
    if (m && m[1]) slugs.add(m[1]);
  }
  return [...slugs].sort();
}
