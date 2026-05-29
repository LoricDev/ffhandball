// src/api/schemas/club.api.ts
import { z } from "@hono/zod-openapi";

export const clubListItemSchema = z.object({
  id_ffhb: z.string().openapi({ description: "Identifiant club FFHB (id_club monclub)", example: "1720" }),
  code_ffhb: z
    .string()
    .nullable()
    .openapi({
      description: "Code FFHB 7 chiffres (préfixe des licences / code sur les FdM). null si inconnu.",
      example: "5221105",
    }),
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

export const clubClassementItemSchema = z.object({
  equipe: z.object({ id_ffhb: z.string(), nom: z.string() }),
  poule: z.object({ id_ffhb: z.string(), nom: z.string() }),
  competition: z.object({ id_ffhb: z.string(), nom: z.string(), niveau: z.string().nullable() }),
  position: z.number().int(),
  points: z.number().int(),
  joues: z.number().int(),
  gagnes: z.number().int(),
  nuls: z.number().int(),
  perdus: z.number().int(),
  buts_pour: z.number().int(),
  buts_contre: z.number().int(),
  difference: z.number().int(),
}).openapi("ClubClassementItem");

export const clubListQuerySchema = z.object({
  q: z.string().min(2).optional().openapi({ description: "Fuzzy search on nom (min 2 chars)" }),
  departement: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional().openapi({ description: "Code département (ex: 75, 2A, 974)" }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
