// src/api/schemas/salle.api.ts
import { z } from "@hono/zod-openapi";

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
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  statut: z.enum(["a_jouer", "joue", "reporte", "annule", "forfait"]).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
