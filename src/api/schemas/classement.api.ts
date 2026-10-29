// src/api/schemas/classement.api.ts
import { z } from "@hono/zod-openapi";
import { dateTimeOut } from "@/api/schemas/shared.js";

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
  capture_date: dateTimeOut,
  equipe_id_ffhb: z.string(),
  equipe_nom: z.string(),
}).openapi("ClassementItem");

export const classementQuerySchema = z.object({
  poule_id_ffhb: z.string().min(1).openapi({ description: "Identifiant FFHB de la poule (obligatoire)", example: "168256" }),
});
