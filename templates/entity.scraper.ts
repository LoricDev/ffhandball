// templates/entity.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// MODÈLE de scraper (parsing pur — AUCUN accès réseau ni base ici).
// Copier vers : src/scrapers/ffhandball/<entity>.scraper.ts
//
// Rôle : transformer du HTML (string) en tableau d'objets validés.
//        La fonction est PURE et SYNCHRONE → facile à tester unitairement.
//
// Particularité ffhandball.fr : les données utiles sont en JSON dans l'attribut
// `attributes` de balises <smartfire-component name="...">. On ne lit donc pas
// des <table>, on parse ce JSON. (Pour un site "HTML classique", parser les
// éléments directement avec les sélecteurs cheerio — voir variante en bas.)
// ─────────────────────────────────────────────────────────────────────────────
import * as cheerio from "cheerio";
import { rawEntityPayloadSchema, type RawEntityPayload } from "@/schemas/entity.schema.js";

/** Lit et parse le JSON de l'attribut `attributes` d'un smartfire-component. */
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

/**
 * @param html       contenu HTML brut de la page
 * @param sourceUrl  URL d'origine (conservée dans chaque payload)
 * @param extPouleId (optionnel) contexte transmis par l'orchestrateur si besoin
 * @returns          tableau d'objets validés, ou null si la page est inattendue
 */
export function parseEntity(
  html: string,
  sourceUrl: string,
  // extPouleId: string,   // ← décommenter si l'entité dépend d'un parent
): RawEntityPayload[] | null {
  const $ = cheerio.load(html);

  // 1. Récupérer le composant qui contient les données.
  const data = loadAttributes($, "competitions---entity") as
    | { items?: Array<Record<string, unknown>> }
    | null;
  if (!data) return null;          // page inattendue → on signale (null) à l'appelant
  if (!data.items) return [];      // page valide mais vide → tableau vide

  // 2. Mapper chaque enregistrement brut → candidat, puis valider via Zod.
  const result: RawEntityPayload[] = [];
  for (const item of data.items) {
    const candidate = {
      ext_entity_id: item.ext_entityId,
      nom: item.libelle,
      // exemple_nombre: item.compteur,
      source_url: sourceUrl,
    };

    const parsed = rawEntityPayloadSchema.safeParse(candidate);
    if (parsed.success) {
      result.push(parsed.data);
    }
    // sinon : ligne silencieusement écartée (les vrais rejets seront tracés à l'ETL)
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIANTE site HTML classique (tableau de lignes) — exemple clubs.scraper.ts :
//
//   $("tr.entity-row").each((_, el) => {
//     const $row = $(el);
//     const candidate = {
//       ext_entity_id: $row.attr("data-id")?.trim() ?? "",
//       nom: $row.find("td.nom").text().trim().replace(/\s+/g, " "),
//       source_url: sourceUrl,
//     };
//     const parsed = rawEntityPayloadSchema.safeParse(candidate);
//     if (parsed.success) result.push(parsed.data);
//   });
// ─────────────────────────────────────────────────────────────────────────────
