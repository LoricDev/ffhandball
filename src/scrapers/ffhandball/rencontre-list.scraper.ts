// src/scrapers/ffhandball/rencontre-list.scraper.ts
import * as cheerio from "cheerio";
import { rawMatchPayloadSchema, type RawMatchPayload } from "@/schemas/match.schema.js";
import { rawEquipePayloadSchema, type RawEquipePayload } from "@/schemas/equipe.schema.js";
import { rawEngagementPayloadSchema, type RawEngagementPayload } from "@/schemas/engagement.schema.js";

export interface RencontreListResult {
  matchs: RawMatchPayload[];
  journees_disponibles: number[];
  // Équipes de la poule (depuis equipe_options) : source COMPLÈTE et fiable, car toute équipe
  // référencée par un match de cette poule y figure (corrige le trou de couverture des équipes,
  // le calendar-button des fiches compétition étant parfois incomplet).
  equipes: RawEquipePayload[];
  engagements: RawEngagementPayload[];
}

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

function parseJourneesDisponibles(journeesField: unknown): number[] {
  let parsed: unknown;
  if (typeof journeesField === "string") {
    try {
      parsed = JSON.parse(journeesField);
    } catch {
      return [];
    }
  } else {
    parsed = journeesField;
  }
  if (!Array.isArray(parsed)) return [];
  const result: number[] = [];
  for (const j of parsed) {
    const item = j as { journee_numero?: unknown };
    if (typeof item.journee_numero === "number") result.push(item.journee_numero);
    else if (typeof item.journee_numero === "string" && /^\d+$/.test(item.journee_numero)) {
      result.push(Number(item.journee_numero));
    }
  }
  return result;
}

export function parseRencontreList(
  html: string,
  sourceUrl: string,
  extPouleId: string,
): RencontreListResult | null {
  const $ = cheerio.load(html);

  const pouleSelector = loadAttributes($, "competitions---poule-selector") as
    | {
        equipe_options?: Array<{ id?: unknown; ext_equipeId?: unknown; libelle?: unknown }>;
        poules?: Array<{ ext_pouleId?: unknown; journees?: unknown }>;
        selected_poule?: { ext_pouleId?: unknown; journees?: unknown };
      }
    | null;
  if (!pouleSelector) return null;

  // Index equipe interne id → ext_equipeId, et capture des équipes/engagements de la poule.
  // equipe_options liste TOUTES les équipes de la poule courante (avec leur libellé) → source
  // complète : c'est ce qui garantit qu'une équipe référencée par un match existe en base.
  const equipeIdIndex = new Map<string, string>();
  const equipes: RawEquipePayload[] = [];
  const engagements: RawEngagementPayload[] = [];
  const seenEquipe = new Set<string>();
  for (const opt of pouleSelector.equipe_options ?? []) {
    const id = typeof opt.id === "string" ? opt.id : null;
    const extId = typeof opt.ext_equipeId === "string" ? opt.ext_equipeId : null;
    if (id && extId) equipeIdIndex.set(id, extId);
    if (!extId) continue;

    const nom = typeof opt.libelle === "string" ? opt.libelle.trim() : null;
    if (nom && !seenEquipe.has(extId)) {
      seenEquipe.add(extId);
      const pe = rawEquipePayloadSchema.safeParse({ ext_equipe_id: extId, nom, source_url: sourceUrl });
      if (pe.success) equipes.push(pe.data);
    }
    const pen = rawEngagementPayloadSchema.safeParse({
      ext_equipe_id: extId,
      ext_poule_id: extPouleId,
      source_url: sourceUrl,
    });
    if (pen.success) engagements.push(pen.data);
  }

  // Journées disponibles (depuis la poule sélectionnée OU celle qui matche extPouleId)
  let journeesSource: unknown = pouleSelector.selected_poule?.journees;
  if (!journeesSource && Array.isArray(pouleSelector.poules)) {
    const found = pouleSelector.poules.find((p) => p.ext_pouleId === extPouleId);
    journeesSource = found?.journees;
  }
  const journees_disponibles = parseJourneesDisponibles(journeesSource);

  // Rencontres
  const rencontreData = loadAttributes($, "competitions---rencontre-list") as
    | { rencontres?: Array<Record<string, unknown>> }
    | null;
  if (!rencontreData?.rencontres) {
    return { matchs: [], journees_disponibles, equipes, engagements };
  }

  const matchs: RawMatchPayload[] = [];
  for (const r of rencontreData.rencontres) {
    const extPouleIdFromRencontre = typeof r.extPouleId === "string" ? r.extPouleId : null;
    if (extPouleIdFromRencontre !== extPouleId) continue;

    const eq1IdInternal = typeof r.equipe1Id === "string" ? r.equipe1Id : null;
    const eq2IdInternal = typeof r.equipe2Id === "string" ? r.equipe2Id : null;
    if (!eq1IdInternal || !eq2IdInternal) continue;

    const extEquipeDom = equipeIdIndex.get(eq1IdInternal);
    const extEquipeExt = equipeIdIndex.get(eq2IdInternal);
    if (!extEquipeDom || !extEquipeExt) continue;
    if (extEquipeDom === extEquipeExt) continue;

    const candidate = {
      ext_rencontre_id: r.ext_rencontreId,
      ext_poule_id: extPouleId,
      ext_equipe_dom_id: extEquipeDom,
      ext_equipe_ext_id: extEquipeExt,
      date_heure: r.date,
      score_dom: r.equipe1Score,
      score_ext: r.equipe2Score,
      score_mt_dom: r.equipe1ScoreMT,
      score_mt_ext: r.equipe2ScoreMT,
      journee: r.journeeNumero,
      equipement_id: typeof r.equipementId === "string" ? r.equipementId : undefined,
      fdm_code: typeof r.fdmCode === "string" ? r.fdmCode : undefined,
      arbitre1_id: typeof r.arbitre1Id === "string" ? r.arbitre1Id : undefined,
      arbitre1_nom: typeof r.arbitre1 === "string" ? r.arbitre1 : undefined,
      arbitre2_id: typeof r.arbitre2Id === "string" ? r.arbitre2Id : undefined,
      arbitre2_nom: typeof r.arbitre2 === "string" ? r.arbitre2 : undefined,
      source_url: sourceUrl,
    };

    const parsed = rawMatchPayloadSchema.safeParse(candidate);
    if (parsed.success) matchs.push(parsed.data);
  }

  return { matchs, journees_disponibles, equipes, engagements };
}
