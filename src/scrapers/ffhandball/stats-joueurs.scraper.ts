// src/scrapers/ffhandball/stats-joueurs.scraper.ts
import * as cheerio from "cheerio";
import { rawStatsJoueurPayloadSchema, type RawStatsJoueurPayload } from "@/schemas/stats-joueur.schema.js";

function loadAttributes($: cheerio.CheerioAPI, componentName: string): unknown | null {
  const el = $(`smartfire-component[name='${componentName}']`).first();
  const raw = el.attr("attributes");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseStatsJoueurs(
  html: string,
  sourceUrl: string,
  extPouleId: string,
): RawStatsJoueurPayload[] {
  const $ = cheerio.load(html);

  // 1. Détecter soft-404 via page-header (régional/dép)
  const header = loadAttributes($, "competitions---page-header") as { is404?: boolean } | null;
  if (header?.is404 === true) return [];

  // 2. Parser stats-joueurs
  const data = loadAttributes($, "competitions---stats-joueurs") as
    | { rowsData?: Array<Record<string, unknown>> }
    | null;
  if (!data?.rowsData) return [];

  const result: RawStatsJoueurPayload[] = [];
  for (const row of data.rowsData) {
    const candidate = {
      ext_poule_id: extPouleId,
      individu_id: row.individuId,
      nom: row.nom,
      prenom: row.prenom,
      equipe_libelle: row.equipeLibelle,
      match_count: row.matchCount,
      total_buts: row.totalButs,
      total_arrets: row.totalArrets,
      source_url: sourceUrl,
    };
    const parsed = rawStatsJoueurPayloadSchema.safeParse(candidate);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
