import * as cheerio from "cheerio";
import { rawClubPayloadSchema, type RawClubPayload } from "@/schemas/club.schema.js";

export function parseClubsListing(html: string, sourceUrl: string): RawClubPayload[] {
  const $ = cheerio.load(html);
  const rows: RawClubPayload[] = [];

  $("tr.club-row").each((_, el) => {
    const $row = $(el);
    const id_ffhb = ($row.attr("data-id-ffhb") ?? $row.find("td.id").text()).trim();
    const nom = $row.find("td.nom").text().trim().replace(/\s+/g, " ");
    const ville = $row.find("td.ville").text().trim() || undefined;
    const dept = $row.find("td.dept").text().trim() || undefined;

    const candidate = {
      id_ffhb,
      nom,
      ville,
      departement_code: dept,
      source_url: sourceUrl,
    };
    const parsed = rawClubPayloadSchema.safeParse(candidate);
    if (parsed.success) {
      rows.push(parsed.data);
    }
  });

  return rows;
}
