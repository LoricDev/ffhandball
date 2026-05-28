// src/scrapers/ffhandball/classement.scraper.ts
import * as cheerio from "cheerio";
import { rawClassementPayloadSchema, type RawClassementPayload } from "@/schemas/classement.schema.js";

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

export function parseClassement(
  html: string,
  sourceUrl: string,
  extPouleId: string,
): RawClassementPayload[] | null {
  const $ = cheerio.load(html);

  // 1. poule-selector → index equipe_options
  const pouleSelector = loadAttributes($, "competitions---poule-selector") as
    | { equipe_options?: Array<{ id?: unknown; ext_equipeId?: unknown }> }
    | null;
  if (!pouleSelector) return null;

  const equipeIdIndex = new Map<string, string>();
  for (const opt of pouleSelector.equipe_options ?? []) {
    const id = typeof opt.id === "string" ? opt.id : null;
    const extId = typeof opt.ext_equipeId === "string" ? opt.ext_equipeId : null;
    if (id && extId) equipeIdIndex.set(id, extId);
  }

  // 2. classement component
  const classementData = loadAttributes($, "competitions---classement") as
    | { classements?: Array<Record<string, unknown>> }
    | null;
  if (!classementData?.classements) return [];

  const result: RawClassementPayload[] = [];
  for (const c of classementData.classements) {
    const equipeIdInternal = typeof c.equipeId === "string" ? c.equipeId : null;
    if (!equipeIdInternal) continue;

    const extEquipeId = equipeIdIndex.get(equipeIdInternal);
    if (!extEquipeId) continue;

    const candidate = {
      ext_classement_id: c.ext_classementId,
      ext_poule_id: extPouleId,
      ext_equipe_id: extEquipeId,
      position: c.place,
      points: c.point,
      joues: c.joue,
      gagnes: c.gagne,
      nuls: c.nul,
      perdus: c.perdu,
      buts_pour: c.butPlus,
      buts_contre: c.butMoins,
      dernieres_rencontres: typeof c.dernieresRencontres === "string" ? c.dernieresRencontres : undefined,
      source_url: sourceUrl,
    };

    const parsed = rawClassementPayloadSchema.safeParse(candidate);
    if (parsed.success) result.push(parsed.data);
  }

  return result;
}
