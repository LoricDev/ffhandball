// src/api/schemas/club-matchs.api.ts
import { z } from "@hono/zod-openapi";
import { isoDateParamSchema, matchStatutSchema } from "@/api/schemas/common.js";
import { clubRefSchema, dateTimeOut } from "@/api/schemas/shared.js";
import { groupeCleSchema, groupeQuerySchema, groupeRefSchema } from "@/api/schemas/equipe.api.js";
import { currentSaison } from "@/lib/saison.js";

export const equipeLieeSchema = z
  .object({
    id_ffhb: z.string().openapi({ example: "EQ-001", description: "Identifiant FFHB de l'équipe" }),
    nom: z.string().openapi({ example: "BREST BRETAGNE HANDBALL", description: "Nom de l'équipe" }),
    is_principal: z
      .boolean()
      .openapi({ description: "True si l'équipe est l'équipe principale du club (match exact sur club.nom)" }),
    is_entente: z
      .boolean()
      .openapi({ description: "True si l'équipe est une entente (nom contient ENTENTE / ENT)" }),
    match_method: z
      .enum(["licence", "structure", "nom_exact", "nom_reserve", "nom_entente"])
      .openapi({
        description:
          "Méthode de détection du lien : licence (≥3 licenciés du club ont joué pour l'équipe), structure (ext_structure_id), nom_exact, nom_reserve, nom_entente",
        example: "nom_exact",
      }),
    confidence: z.enum(["haute", "moyenne", "basse"]).openapi({
      description:
        "Confiance du lien : haute (licence/structure/nom_exact), moyenne (nom_reserve), basse (nom_entente)",
      example: "haute",
    }),
  })
  .openapi("EquipeLiee");

export const clubMatchItemSchema = z
  .object({
    id_ffhb_match: z.string().openapi({ example: "M-12345", description: "Identifiant FFHB du match" }),
    date_heure: dateTimeOut
      .openapi({ example: "2026-09-03T20:00:00.000Z", description: "Date et heure du match (ISO 8601)" }),
    statut: matchStatutSchema.openapi({ example: "joue" }),
    forfait_equipe: z
      .enum(["dom", "ext"])
      .nullable()
      .openapi({ example: null, description: "Équipe ayant fait forfait (score « FO » sur ffhandball.fr), null sinon" }),
    journee: z.number().int().nullable().openapi({ example: 1, description: "Numéro de journée" }),
    equipe_dom_id_ffhb: z.string().openapi({ description: "Identifiant FFHB de l'équipe domicile" }),
    equipe_dom_nom: z.string().openapi({ example: "BREST BRETAGNE HANDBALL", description: "Équipe domicile" }),
    equipe_ext_id_ffhb: z.string().openapi({ description: "Identifiant FFHB de l'équipe extérieure" }),
    equipe_ext_nom: z.string().openapi({ example: "PARIS 92", description: "Équipe extérieure" }),
    score_dom: z.number().int().nullable().openapi({ example: 28, description: "Score domicile (null si non joué)" }),
    score_ext: z.number().int().nullable().openapi({ example: 25, description: "Score extérieur (null si non joué)" }),
    poule_id_ffhb: z.string().openapi({ example: "PO-001", description: "Identifiant FFHB de la poule" }),
    competition_nom: z.string().openapi({ example: "Lidl Starligue", description: "Nom de la compétition" }),
    fdm_url: z
      .string()
      .nullable()
      .openapi({ example: "https://fdm.ffhandball.fr/...", description: "URL feuille de match PDF" }),
    logo_dom: z.string().nullable().openapi({ example: "2015-06-26-b57558ab.png", description: "Fichier logo du club de l'équipe domicile (même valeur que `logo_club` de GET /clubs/{id})  ; à défaut, logo de l'équipe côté FFHB, ou du club porteur (équipes hors ententes) ; null : aucun" }),
    logo_ext: z.string().nullable().openapi({ description: "Fichier logo du club de l'équipe extérieure ; null si aucun" }),
    phase_nom: z.string().openapi({ example: "CDF REG MAS (1° TOUR)", description: "Nom de la phase (porte le tour d'une coupe)" }),
    poule_nom: z.string().openapi({ example: "1ER TOUR" }),
    equipement_id: z.string().nullable().openapi({
      example: "842",
      description:
        "Identifiant FFHB de l'équipement (salle) où se joue le match (voir `salle_*` pour son nom).",
    }),
    salle_id_ffhb: z.string().nullable().openapi({ example: "842", description: "Identifiant à passer à /salles/{id} (équipement connu d'après les feuilles de match, ou salle FFHB rattachée) ; null si la salle n'est pas identifiée" }),
    salle_nom: z.string().nullable().openapi({ example: "COSEC LA LOUVIERE" }),
    salle_ville: z.string().nullable().openapi({ example: "MARLY" }),
    salle_adresse: z.string().nullable().openapi({ example: "RUE CROIX ST JOSEPH 57155 MARLY" }),
    salle_approx: z.boolean().openapi({ description: "true : salle déduite de la salle principale du club recevant (équipement pas encore connu), donc approximative ; false : salle issue de la feuille de match ou d'une salle FFHB rattachée, ou aucune salle" }),
    club_recevant: z
      .boolean()
      .openapi({ description: "True si le club joue ce match à domicile (équipe liée est l'équipe dom)" }),
    via_entente: z
      .boolean()
      .openapi({ description: "True si ce match est lié au club via une équipe entente" }),
    via_principal: z
      .boolean()
      .openapi({ description: "True si ce match est lié au club via son équipe principale (vs réserve ou entente)" }),
    confidence: z.enum(["haute", "moyenne", "basse"]).openapi({
      description: "Confiance du lien équipe↔club qui rattache ce match au club",
      example: "haute",
    }),
    groupe_cle: groupeCleSchema,
  })
  .openapi("ClubMatchItem");

export const clubMatchsQuerySchema = z.object({
  saison: z
    .string()
    .regex(/^\d{4}-\d{4}$/)
    .default(() => currentSaison())
    .openapi({
      description: "Code saison (format YYYY-YYYY)",
      example: "2025-2026",
    }),
  include_ententes: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true")
    .openapi({
      description: "Inclure les matchs des équipes ententes où participe le club (défaut true)",
      example: "true",
    }),
  date_from: isoDateParamSchema
    .optional()
    .openapi({
      description: "Filtre date de début (ISO 8601, ex: 2025-09-01)",
      example: "2025-09-01",
    }),
  date_to: isoDateParamSchema
    .optional()
    .openapi({
      description: "Filtre date de fin (ISO 8601, ex: 2026-06-30)",
      example: "2026-06-30",
    }),
  statut: matchStatutSchema
    .optional()
    .openapi({
      description: "Filtre sur le statut du match",
      example: "joue",
    }),
  min_confidence: z
    .enum(["haute", "moyenne", "basse"])
    .optional()
    .openapi({
      description:
        "Filtre les équipes liées (et leurs matchs) par confiance minimale. Absent = toutes confiances.",
      example: "haute",
    }),
  groupe: groupeQuerySchema,
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .openapi({ description: "Nombre de résultats par page (1-100, défaut 20)", example: 20 }),
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0)
    .openapi({ description: "Décalage pour la pagination (défaut 0)", example: 0 }),
});

export const clubMatchsMetaSchema = z
  .object({
    total: z.number().int().nonnegative().openapi({ description: "Nombre total de matchs correspondant aux filtres" }),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    saison: z.string().openapi({ example: "2026-2027", description: "Saison utilisée pour cette réponse" }),
    club: clubRefSchema.openapi({ description: "Informations du club" }),
    groupes: z.array(groupeRefSchema).openapi({ description: "Équipes réelles du club pour la saison ; `data[].groupe_cle` y renvoie" }),
    equipes_liees: z
      .array(equipeLieeSchema)
      .openapi({
        description:
          "Liste des équipes identifiées comme appartenant au club (transparence sur le matching textuel)",
      }),
  })
  .openapi("ClubMatchsMeta");
