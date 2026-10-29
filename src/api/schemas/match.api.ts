// src/api/schemas/match.api.ts
import { z } from "@hono/zod-openapi";
import { dateTimeOut } from "@/api/schemas/shared.js";
import { isoDateParamSchema, matchStatutSchema, saisonCodeSchema, triDateSchema } from "@/api/schemas/common.js";

export const matchListItemSchema = z.object({
  id_ffhb_match: z.string(),
  date_heure: dateTimeOut,
  statut: matchStatutSchema,
  forfait_equipe: z.enum(["dom", "ext"]).nullable().openapi({
    description: "Équipe ayant fait forfait (score affiché « FO » sur ffhandball.fr), null sinon",
  }),
  journee: z.number().int().nullable(),
  equipe_dom_id_ffhb: z.string(),
  equipe_dom_nom: z.string(),
  equipe_ext_id_ffhb: z.string(),
  equipe_ext_nom: z.string(),
  score_dom: z.number().int().nullable(),
  score_ext: z.number().int().nullable(),
  poule_id_ffhb: z.string(),
  competition_nom: z.string(),
  fdm_url: z.string().nullable(),
  logo_dom: z.string().nullable().openapi({ example: "2015-06-26-b57558ab.png", description: "Fichier logo du club de l'équipe domicile (même valeur que `logo_club` de GET /clubs/{id}) ; null : entente sans club résolu ou pas de logo" }),
  logo_ext: z.string().nullable().openapi({ description: "Fichier logo du club de l'équipe extérieure ; null si aucun" }),
  phase_nom: z.string().openapi({ example: "CDF REG MAS (1° TOUR)", description: "Nom de la phase (porte le tour d'une coupe)" }),
  poule_nom: z.string().openapi({ example: "1ER TOUR" }),
  equipement_id: z.string().nullable().openapi({
    example: "842",
    description:
      "Identifiant FFHB de l'équipement (salle) où se joue le match. Ce n'est PAS l'id d'une salle de /salles (celles-ci ont un slug nom+code postal+ville) : aucun lien n'est encore résolu entre les deux.",
  }),
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
  score_mt_dom: z.number().int().nullable(),
  score_mt_ext: z.number().int().nullable(),
  heure_estimee: z.boolean(),
  compositions: z.array(compositionItemSchema),
  actions: z.array(actionItemSchema),
  officiels: z.array(officielItemSchema),
}).openapi("MatchDetail");

/** Filtres communs aux listes de matchs (/matchs, /equipes/{id}/matchs, /salles/{id}/matchs, /poules/{id}/matchs). */
export const matchFiltersQuery = {
  date_from: isoDateParamSchema.optional().openapi({ description: "Matchs à partir de cette date (ISO 8601)" }),
  date_to: isoDateParamSchema.optional().openapi({ description: "Matchs jusqu'à cette date (ISO 8601)" }),
  statut: matchStatutSchema.optional(),
  journee: z.coerce.number().int().positive().optional().openapi({ description: "Numéro de journée de championnat" }),
  tri: triDateSchema.optional(),
};

export const matchListQuerySchema = z.object({
  poule_id_ffhb: z.string().optional().openapi({ description: "Filtre par poule (id_ffhb)" }),
  competition_id_ffhb: z.string().optional().openapi({ description: "Filtre par compétition (id_ffhb)" }),
  equipe_id_ffhb: z.string().optional().openapi({
    description: "Matchs d'une équipe (domicile ou extérieur). Les ids d'équipe sont propres à une saison.",
  }),
  club_id_ffhb: z.string().optional().openapi({
    description: "Matchs des équipes portées par ce club (id_club FFHB). Pour inclure les ententes, voir /clubs/{id}/matchs.",
  }),
  salle_id_ffhb: z.string().optional().openapi({ description: "Matchs accueillis par cette salle (id_ffhb)" }),
  ...matchFiltersQuery,
  tri: triDateSchema.optional().openapi({ description: "Tri par date de match (défaut : date_desc)" }),
  saison: saisonCodeSchema
    .optional()
    .openapi({ example: "2026-2027", description: "Filtre sur une saison. Sans ce paramètre : toutes les saisons (voir /saisons)." }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
