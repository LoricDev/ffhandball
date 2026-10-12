// src/scrapers/ffhandball/rencontre-list.scraper.ts
import * as cheerio from "cheerio";
import { rawMatchPayloadSchema, type RawMatchPayload } from "@/schemas/match.schema.js";
import { rawEquipePayloadSchema, type RawEquipePayload } from "@/schemas/equipe.schema.js";
import { rawEngagementPayloadSchema, type RawEngagementPayload } from "@/schemas/engagement.schema.js";

export interface JourneeInfo {
  numero: number;
  date_debut: string | null;
  date_fin: string | null;
}

export interface RencontreListResult {
  matchs: RawMatchPayload[];
  // Journées de la poule avec leurs dates (pour cibler le scraping : sauter les journées
  // futures non jouées, ne garder qu'une fenêtre récente, etc.).
  journees: JourneeInfo[];
  // Numéros seuls — dérivé de `journees` (rétro-compat).
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

function parseJournees(journeesField: unknown): JourneeInfo[] {
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
  const result: JourneeInfo[] = [];
  for (const j of parsed) {
    const item = j as { journee_numero?: unknown; date_debut?: unknown; date_fin?: unknown };
    let numero: number | null = null;
    if (typeof item.journee_numero === "number") numero = item.journee_numero;
    else if (typeof item.journee_numero === "string" && /^\d+$/.test(item.journee_numero)) {
      numero = Number(item.journee_numero);
    }
    if (numero === null) continue;
    result.push({
      numero,
      date_debut: typeof item.date_debut === "string" ? item.date_debut : null,
      date_fin: typeof item.date_fin === "string" ? item.date_fin : null,
    });
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
  const journees = parseJournees(journeesSource);
  const journees_disponibles = journees.map((j) => j.numero);

  // Rencontres
  const rencontreData = loadAttributes($, "competitions---rencontre-list") as
    | { rencontres?: Array<Record<string, unknown>> }
    | null;
  if (!rencontreData?.rencontres) {
    return { matchs: [], journees, journees_disponibles, equipes, engagements };
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

  return { matchs, journees, journees_disponibles, equipes, engagements };
}
