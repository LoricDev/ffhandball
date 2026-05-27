// src/scrapers/ffhandball/competition-list.scraper.ts
import * as cheerio from "cheerio";
import {
  rawCompetitionPayloadSchema,
  type RawCompetitionPayload,
} from "@/schemas/competition.schema.js";

export interface StructureMeta {
  ext_structure_id: string;
  libelle: string;
  sigle?: string;
  code?: string;
  type?: string;
}

const TYPE_TO_NIVEAU: Record<string, "national" | "regional" | "departemental"> = {
  NATIONAL: "national",
  REGIONAL: "regional",
  DEPARTEMENTAL: "departemental",
  COUPE_DE_FRANCE: "national",
  INTER_LIGUES: "national",
  INTER_COMITES: "national",
};

const GENRE_TO_SEXE: Record<string, "M" | "F" | "mixte"> = {
  FEMININ: "F",
  MASCULIN: "M",
  MIXTE: "mixte",
};

export function slugifyLibelle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadAttributes(html: string): unknown | null {
  const $ = cheerio.load(html);
  const el = $("smartfire-component[name='competitions---competition-main-menu']").first();
  const raw = el.attr("attributes");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseCompetitionList(
  html: string,
  niveau: "national" | "regional" | "departemental",
  sourceUrl: string,
  saison: string,        // ex: "2025-2026"
  extSaisonId: string,   // ex: "21"
): RawCompetitionPayload[] {
  const data = loadAttributes(html);
  if (!data || typeof data !== "object") return [];
  const competitions = (data as { competitions?: unknown }).competitions;
  if (!Array.isArray(competitions)) return [];

  const seen = new Set<string>();
  const out: RawCompetitionPayload[] = [];

  for (const c of competitions) {
    const item = c as Record<string, unknown>;
    const ext = typeof item.ext_competitionId === "string" ? item.ext_competitionId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    const type = typeof item.type === "string" ? item.type : null;
    if (!ext || !libelle || !type) continue;
    if (seen.has(ext)) continue;
    seen.add(ext);

    const mappedNiveau = TYPE_TO_NIVEAU[type];
    if (!mappedNiveau) continue;

    const genre = typeof item.genre === "string" ? item.genre : null;
    const sexe = genre ? GENRE_TO_SEXE[genre] : undefined;
    const code = typeof item.code === "string" ? item.code : undefined;
    const ext_structure_id =
      typeof item.structureId === "string" ? item.structureId : undefined;

    const niveauUrl = mappedNiveau; // url segment same as niveau
    const detail_url = `https://www.ffhandball.fr/competitions/saison-${saison}-${extSaisonId}/${niveauUrl}/${slugifyLibelle(libelle)}-${ext}/`;

    const candidate = {
      ext_competition_id: ext,
      nom: libelle,
      niveau: mappedNiveau,
      sexe,
      code,
      ext_structure_id,
      detail_url,
      source_url: sourceUrl,
    };

    const parsed = rawCompetitionPayloadSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parseStructures(html: string): StructureMeta[] {
  const data = loadAttributes(html);
  if (!data || typeof data !== "object") return [];
  const structures = (data as { structures?: unknown }).structures;
  if (!Array.isArray(structures)) return [];

  const out: StructureMeta[] = [];
  for (const s of structures) {
    const item = s as Record<string, unknown>;
    const ext = typeof item.ext_structureId === "string" ? item.ext_structureId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!ext || !libelle) continue;
    out.push({
      ext_structure_id: ext,
      libelle,
      sigle: typeof item.sigle === "string" ? item.sigle : undefined,
      code: typeof item.code === "string" ? item.code : undefined,
      type: typeof item.type === "string" ? item.type : undefined,
    });
  }
  return out;
}
