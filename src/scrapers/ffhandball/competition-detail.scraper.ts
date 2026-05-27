import * as cheerio from "cheerio";
import { rawPhasePayloadSchema, type RawPhasePayload } from "@/schemas/phase.schema.js";
import { rawPoulePayloadSchema, type RawPoulePayload } from "@/schemas/poule.schema.js";
import { rawEquipePayloadSchema, type RawEquipePayload } from "@/schemas/equipe.schema.js";
import { rawEngagementPayloadSchema, type RawEngagementPayload } from "@/schemas/engagement.schema.js";

export interface CompetitionDetailResult {
  phases: RawPhasePayload[];
  poules: RawPoulePayload[];
  equipes: RawEquipePayload[];
  engagements: RawEngagementPayload[];
}

interface SourceTeam {
  id?: unknown;
  ext_equipeId?: unknown;
  pouleId?: unknown;
  structureId?: unknown;
  ext_structureId?: unknown;
  libelle?: unknown;
  logo?: unknown;
  logoActif?: unknown;
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

export function parseCompetitionDetail(
  html: string,
  sourceUrl: string,
  extCompetitionId: string,
): CompetitionDetailResult | null {
  const $ = cheerio.load(html);

  // 1. poule-selector → phases + poules + index (pouleId interne → ext_poule_id)
  const pouleSelectorData = loadAttributes($, "competitions---poule-selector");
  if (!pouleSelectorData) return null;

  const root = pouleSelectorData as {
    phases?: unknown;
    poules?: unknown;
    equipe_options?: unknown;
  };

  const rawPhases = Array.isArray(root.phases) ? root.phases : [];
  const rawPoules = Array.isArray(root.poules) ? root.poules : [];

  // Build id → ext_phaseId mapping (existing)
  const phaseIdIndex = new Map<string, string>();
  const phases: RawPhasePayload[] = [];
  for (const ph of rawPhases) {
    const item = ph as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : null;
    const extPhaseId = typeof item.ext_phaseId === "string" ? item.ext_phaseId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!id || !extPhaseId || !libelle) continue;
    phaseIdIndex.set(id, extPhaseId);

    const parsed = rawPhasePayloadSchema.safeParse({
      ext_phase_id: extPhaseId,
      ext_competition_id: extCompetitionId,
      nom: libelle,
      source_url: sourceUrl,
    });
    if (parsed.success) phases.push(parsed.data);
  }

  // Build internal pouleId → ext_poule_id mapping
  const pouleIdIndex = new Map<string, string>();
  const poules: RawPoulePayload[] = [];
  for (const po of rawPoules) {
    const item = po as Record<string, unknown>;
    const internalPouleId = typeof item.id === "string" ? item.id : null;
    const extPouleId = typeof item.ext_pouleId === "string" ? item.ext_pouleId : null;
    const internalPhaseId = typeof item.phaseId === "string" ? item.phaseId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!internalPouleId || !extPouleId || !internalPhaseId || !libelle) continue;

    pouleIdIndex.set(internalPouleId, extPouleId);

    const extPhaseId = phaseIdIndex.get(internalPhaseId);
    if (!extPhaseId) continue;

    const parsed = rawPoulePayloadSchema.safeParse({
      ext_poule_id: extPouleId,
      ext_phase_id: extPhaseId,
      nom: libelle,
      source_url: sourceUrl,
    });
    if (parsed.success) poules.push(parsed.data);
  }

  // 2. NOUVEAU : équipes + engagements depuis calendar-button (avec fallback equipe_options)
  const calendarData = loadAttributes($, "competitions---calendar-button") as
    | { equipes?: unknown }
    | null;

  let rawTeams: SourceTeam[] = [];
  if (calendarData && Array.isArray(calendarData.equipes) && calendarData.equipes.length > 0) {
    rawTeams = calendarData.equipes as SourceTeam[];
  } else if (Array.isArray(root.equipe_options) && root.equipe_options.length > 0) {
    rawTeams = root.equipe_options as SourceTeam[];
  }

  const equipes: RawEquipePayload[] = [];
  const engagements: RawEngagementPayload[] = [];
  const seenEquipeIds = new Set<string>();
  const seenEngagements = new Set<string>();

  for (const t of rawTeams) {
    const extEquipeId = typeof t.ext_equipeId === "string" ? t.ext_equipeId : null;
    const nom = typeof t.libelle === "string" ? t.libelle.trim() : null;
    const internalPouleId = typeof t.pouleId === "string" ? t.pouleId : null;
    if (!extEquipeId || !nom || !internalPouleId) continue;

    const extPouleId = pouleIdIndex.get(internalPouleId);
    if (!extPouleId) continue; // orpheline

    if (!seenEquipeIds.has(extEquipeId)) {
      seenEquipeIds.add(extEquipeId);
      const parsedEq = rawEquipePayloadSchema.safeParse({
        ext_equipe_id: extEquipeId,
        nom,
        ext_structure_id: typeof t.ext_structureId === "string" ? t.ext_structureId : undefined,
        logo: typeof t.logo === "string" ? t.logo : undefined,
        source_url: sourceUrl,
      });
      if (parsedEq.success) equipes.push(parsedEq.data);
    }

    const engKey = `${extEquipeId}-${extPouleId}`;
    if (!seenEngagements.has(engKey)) {
      seenEngagements.add(engKey);
      const parsedEn = rawEngagementPayloadSchema.safeParse({
        ext_equipe_id: extEquipeId,
        ext_poule_id: extPouleId,
        source_url: sourceUrl,
      });
      if (parsedEn.success) engagements.push(parsedEn.data);
    }
  }

  return { phases, poules, equipes, engagements };
}
