// src/api/schemas/joueur.api.ts
import { z } from "@hono/zod-openapi";

const joueurHistoriqueItemSchema = z.object({
  id_ffhb_match: z.string(),
  date_heure: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v)),
  equipe_dom_nom: z.string(),
  equipe_ext_nom: z.string(),
  score_dom: z.number().int().nullable(),
  score_ext: z.number().int().nullable(),
  equipe_joueur_nom: z.string(),
  buts: z.number().int(),
  tirs: z.number().int(),
  arrets: z.number().int(),
}).openapi("JoueurHistoriqueItem");

const joueurStatsSchema = z.object({
  total_buts: z.number().int(),
  total_exclusions_2min: z.number().int(),
  total_tirs: z.number().int(),
  total_arrets: z.number().int(),
  total_matchs: z.number().int(),
}).openapi("JoueurStats");

export const joueurDetailSchema = z.object({
  numero_licence: z.string(),
  nom: z.string(),
  prenom: z.string(),
  date_naissance: z.string().nullable(),
  sexe: z.string().nullable(),
  nationalite: z.string().nullable(),
  stats: joueurStatsSchema,
  historique: z.array(joueurHistoriqueItemSchema),
}).openapi("JoueurDetail");
