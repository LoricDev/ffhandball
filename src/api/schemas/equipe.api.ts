// src/api/schemas/equipe.api.ts
import { z } from "@hono/zod-openapi";

export const engagementRefSchema = z
  .object({
    poule: z.object({ id_ffhb: z.string(), nom: z.string() }),
    phase: z.object({ id_ffhb: z.string(), nom: z.string() }),
    competition: z.object({ id_ffhb: z.string(), nom: z.string(), niveau: z.string().nullable() }),
  })
  .openapi("EngagementRef");

export const equipeDetailSchema = z
  .object({
    id_ffhb: z.string(),
    nom: z.string(),
    saison_code: z.string(),
    club: z
      .object({ id_ffhb: z.string(), code_ffhb: z.string().nullable(), nom: z.string() })
      .nullable()
      .openapi({ description: "Club résolu via le pont ext_structure_id = clubs.id_ffhb" }),
    engagements: z.array(engagementRefSchema),
  })
  .openapi("EquipeDetail");

export const clubEquipeSchema = z
  .object({ id_ffhb: z.string(), nom: z.string(), engagements: z.array(engagementRefSchema) })
  .openapi("ClubEquipe");

export const rosterJoueurItemSchema = z
  .object({
    numero_licence: z.string(),
    nom: z.string(),
    prenom: z.string(),
    matchs: z.number().int(),
    buts: z.number().int(),
  })
  .openapi("RosterJoueurItem");

export const equipeMatchsQuerySchema = z.object({
  saison: z.string().regex(/^\d{4}-\d{4}$/).default("2025-2026"),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  statut: z.enum(["a_jouer", "joue", "reporte", "annule", "forfait"]).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
