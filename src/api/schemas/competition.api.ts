// src/api/schemas/competition.api.ts
import { z } from "@hono/zod-openapi";
import { classementItemSchema } from "@/api/schemas/classement.api.js";

export const competitionListItemSchema = z
  .object({
    id_ffhb: z.string().openapi({ example: "28227" }),
    nom: z.string().openapi({ example: "Ligue Butagaz Energie" }),
    niveau: z.string().nullable().openapi({ example: "national" }),
    sexe: z.string().nullable().openapi({ example: "F" }),
    categorie_age: z.string().nullable(),
    code: z.string().nullable(),
    saison_code: z.string().openapi({ example: "2025-2026" }),
  })
  .openapi("CompetitionListItem");

export const pouleRefSchema = z
  .object({ id_ffhb: z.string(), nom: z.string() })
  .openapi("PouleRef");

export const phaseWithPoulesSchema = z
  .object({ id_ffhb: z.string(), nom: z.string(), poules: z.array(pouleRefSchema) })
  .openapi("PhaseWithPoules");

export const competitionDetailSchema = competitionListItemSchema
  .extend({ phases: z.array(phaseWithPoulesSchema) })
  .openapi("CompetitionDetail");

export const competitionListQuerySchema = z.object({
  saison: z.string().regex(/^\d{4}-\d{4}$/).default("2025-2026").openapi({ example: "2025-2026" }),
  niveau: z.enum(["national", "regional", "departemental"]).optional(),
  sexe: z.enum(["M", "F", "mixte"]).optional(),
  q: z.string().min(2).optional().openapi({ description: "Recherche floue sur le nom (min 2 chars)" }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const saisonQuerySchema = z.object({
  saison: z.string().regex(/^\d{4}-\d{4}$/).default("2025-2026").openapi({ example: "2025-2026" }),
});

export const pouleDetailSchema = z
  .object({
    id_ffhb: z.string(),
    nom: z.string(),
    saison_code: z.string(),
    phase: z.object({ id_ffhb: z.string(), nom: z.string() }),
    competition: z.object({ id_ffhb: z.string(), nom: z.string(), niveau: z.string().nullable() }),
    classement: z.array(classementItemSchema),
  })
  .openapi("PouleDetail");
