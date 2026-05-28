// src/api/schemas/club.api.ts
import { z } from "@hono/zod-openapi";

export const clubListItemSchema = z.object({
  id_ffhb: z.string(),
  nom: z.string(),
  ville: z.string().nullable(),
  departement_code: z.string().nullable(),
  telephone: z.string().nullable(),
  email: z.string().nullable(),
  site_web: z.string().nullable(),
}).openapi("ClubListItem");

export const clubDetailSchema = clubListItemSchema.extend({
  sigle: z.string().nullable(),
  adresse_correspondance: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  logo_club: z.string().nullable(),
  effectif_estime: z.number().int().nullable(),
  salle_principale: z.object({
    id_ffhb: z.string(),
    nom: z.string(),
    adresse: z.string().nullable(),
    code_postal: z.string().nullable(),
    ville: z.string().nullable(),
  }).nullable(),
}).openapi("ClubDetail");

export const clubListQuerySchema = z.object({
  q: z.string().min(2).optional().openapi({ description: "Fuzzy search on nom (min 2 chars)" }),
  departement: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional().openapi({ description: "Code département (ex: 75, 2A, 974)" }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
