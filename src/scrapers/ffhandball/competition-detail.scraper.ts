// src/scrapers/ffhandball/competition-detail.scraper.ts
import * as cheerio from "cheerio";
import { rawPhasePayloadSchema, type RawPhasePayload } from "@/schemas/phase.schema.js";
import { rawPoulePayloadSchema, type RawPoulePayload } from "@/schemas/poule.schema.js";

export interface CompetitionDetailResult {
  phases: RawPhasePayload[];
  poules: RawPoulePayload[];
}

export function parseCompetitionDetail(
  html: string,
  sourceUrl: string,
  extCompetitionId: string,
): CompetitionDetailResult | null {
  const $ = cheerio.load(html);
  const el = $("smartfire-component[name='competitions---poule-selector']").first();
  const raw = el.attr("attributes");
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const root = data as { phases?: unknown; poules?: unknown };
  const rawPhases = Array.isArray(root.phases) ? root.phases : [];
  const rawPoules = Array.isArray(root.poules) ? root.poules : [];

  // Build id → ext_phaseId mapping
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

  const poules: RawPoulePayload[] = [];
  for (const po of rawPoules) {
    const item = po as Record<string, unknown>;
    const extPouleId = typeof item.ext_pouleId === "string" ? item.ext_pouleId : null;
    const phaseId = typeof item.phaseId === "string" ? item.phaseId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!extPouleId || !phaseId || !libelle) continue;

    const extPhaseId = phaseIdIndex.get(phaseId);
    if (!extPhaseId) continue; // orphan — skip

    const parsed = rawPoulePayloadSchema.safeParse({
      ext_poule_id: extPouleId,
      ext_phase_id: extPhaseId,
      nom: libelle,
      source_url: sourceUrl,
    });
    if (parsed.success) poules.push(parsed.data);
  }

  return { phases, poules };
}
