// src/api/schemas/classement.api.ts
import { z } from "@hono/zod-openapi";

export const classementItemSchema = z.object({
  position: z.number().int(),
  points: z.number().int(),
  joues: z.number().int(),
  gagnes: z.number().int(),
  nuls: z.number().int(),
  perdus: z.number().int(),
  buts_pour: z.number().int(),
  buts_contre: z.number().int(),
  difference: z.number().int(),
  dernieres_rencontres: z.string().nullable(),
  capture_date: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v)),
  equipe_id_ffhb: z.string(),
  equipe_nom: z.string(),
}).openapi("ClassementItem");

export const classementQuerySchema = z.object({
  poule_id_ffhb: z.string().optional().openapi({ description: "Identifiant FFH de la poule (obligatoire)" }),
});
