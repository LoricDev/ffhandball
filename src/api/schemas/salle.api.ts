// src/api/schemas/salle.api.ts
import { z } from "@hono/zod-openapi";
import { triDateSchema } from "@/api/schemas/common.js";
import { matchFiltersQuery } from "@/api/schemas/match.api.js";

export const salleDetailSchema = z
  .object({
    id_ffhb: z.string(),
    nom: z.string(),
    adresse: z.string().nullable(),
    code_postal: z.string().nullable(),
    ville: z.string().nullable(),
    departement_code: z.string().nullable(),
    capacite: z.number().int().nullable(),
  })
  .openapi("SalleDetail");

export const salleMatchsQuerySchema = z.object({
  ...matchFiltersQuery,
  tri: triDateSchema.optional().openapi({ description: "Tri par date de match (défaut : date_asc)" }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
