// src/api/schemas/arbitre.api.ts
import { z } from "@hono/zod-openapi";

export const arbitreListItemSchema = z
  .object({
    id_ffhb: z.string().nullable(),
    numero_licence: z.string().nullable(),
    nom_complet: z.string().nullable(),
    nom: z.string(),
    prenom: z.string().nullable(),
    niveau: z.string().nullable(),
  })
  .openapi("ArbitreListItem");

export const arbitreMatchItemSchema = z
  .object({
    id_ffhb_match: z.string(),
    date_heure: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v)),
    role: z.string(),
    equipe_dom_nom: z.string(),
    equipe_ext_nom: z.string(),
    poule_id_ffhb: z.string(),
    competition_nom: z.string(),
  })
  .openapi("ArbitreMatchItem");

export const arbitreListQuerySchema = z.object({
  q: z.string().min(2).optional().openapi({ description: "Recherche floue sur le nom (min 2 chars)" }),
  niveau: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export const arbitreDetailSchema = arbitreListItemSchema
  .extend({ nb_matchs: z.number().int() })
  .openapi("ArbitreDetail");
