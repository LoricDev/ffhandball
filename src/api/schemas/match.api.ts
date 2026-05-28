// src/api/schemas/match.api.ts
import { z } from "@hono/zod-openapi";

export const matchListItemSchema = z.object({
  id_ffhb_match: z.string(),
  date_heure: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString() : v)),
  statut: z.string(),
  journee: z.number().int().nullable(),
  equipe_dom_nom: z.string(),
  equipe_ext_nom: z.string(),
  score_dom: z.number().int().nullable(),
  score_ext: z.number().int().nullable(),
  poule_id_ffhb: z.string(),
  competition_nom: z.string(),
  fdm_url: z.string().nullable(),
}).openapi("MatchListItem");

const compositionItemSchema = z.object({
  cote: z.enum(["dom", "ext"]),
  joueur: z.object({
    numero_licence: z.string(),
    nom: z.string(),
    prenom: z.string(),
  }),
  numero_maillot: z.number().int().nullable(),
  type_licence: z.string().nullable(),
  capitaine: z.boolean(),
  gardien: z.boolean(),
  buts: z.number().int(),
  tirs: z.number().int(),
  arrets: z.number().int(),
  sept_metres_reussis: z.number().int(),
  avertissement: z.boolean(),
  exclusions_2min: z.number().int(),
  disqualifie: z.boolean(),
}).openapi("CompositionItem");

const actionItemSchema = z.object({
  ordre: z.number().int(),
  periode: z.number().int(),
  temps_seconds: z.number().int(),
  score_recevant: z.number().int(),
  score_visiteur: z.number().int(),
  type_action: z.string(),
  cote: z.string().nullable(),
  numero_maillot: z.number().int().nullable(),
  description_brute: z.string().nullable(),
}).openapi("ActionItem");

const officielItemSchema = z.object({
  role: z.string(),
  arbitre_nom: z.string(),
  arbitre_prenom: z.string().nullable(),
}).openapi("OfficielItem");

export const matchDetailSchema = matchListItemSchema.extend({
  equipe_dom_id_ffhb: z.string(),
  equipe_ext_id_ffhb: z.string(),
  score_mt_dom: z.number().int().nullable(),
  score_mt_ext: z.number().int().nullable(),
  heure_estimee: z.boolean(),
  equipement_id: z.string().nullable(),
  compositions: z.array(compositionItemSchema),
  actions: z.array(actionItemSchema),
  officiels: z.array(officielItemSchema),
}).openapi("MatchDetail");

export const matchListQuerySchema = z.object({
  poule_id_ffhb: z.string().optional().openapi({ description: "Filtre par poule (id_ffhb)" }),
  date_from: z.string().optional().openapi({ description: "Date début ISO 8601" }),
  date_to: z.string().optional().openapi({ description: "Date fin ISO 8601" }),
  statut: z.enum(["a_jouer", "joue", "reporte", "annule", "forfait"]).optional().openapi({ description: "Statut match" }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
