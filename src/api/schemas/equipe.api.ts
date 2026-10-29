// src/api/schemas/equipe.api.ts
import { z } from "@hono/zod-openapi";
import { triDateSchema } from "@/api/schemas/common.js";
import { matchFiltersQuery } from "@/api/schemas/match.api.js";
import { pouleRefSchema, saisonQuerySchema } from "@/api/schemas/competition.api.js";
import { clubRefSchema, competitionRefSchema, phaseRefSchema } from "@/api/schemas/shared.js";
import { currentSaison } from "@/lib/saison.js";

export const engagementRefSchema = z
  .object({
    poule: pouleRefSchema,
    phase: phaseRefSchema,
    competition: competitionRefSchema,
  })
  .openapi("EngagementRef");

export const groupeRefSchema = z
  .object({
    cle: z.string().openapi({ example: "-13|M|1|entente", description: "Clé stable du groupe : catégorie|sexe|rang|club ou entente" }),
    categorie: z.enum(["Seniors", "-20", "-19", "-18", "-17", "-15", "-13", "-11", "-9", "-7", "Loisir", "Autre"]),
    sexe: z.enum(["M", "F", "mixte"]),
    rang: z.number().int().positive().openapi({ description: "1 = équipe première ; 2, 3… = équipes réserves (chiffre ou lettre finale du nom)" }),
    entente: z.boolean().openapi({ description: "true si l'équipe est une entente ou une convention entre clubs" }),
    libelle: z.string().openapi({ example: "-13 M — entente" }),
  })
  .openapi("GroupeRef");

export const equipeDetailSchema = z
  .object({
    id_ffhb: z.string(),
    nom: z.string(),
    saison_code: z.string(),
    club: clubRefSchema
      .nullable()
      .openapi({ description: "Club résolu via le pont ext_structure_id = clubs.id_ffhb" }),
    engagements: z.array(engagementRefSchema),
    groupe: groupeRefSchema.nullable().openapi({ description: "Équipe réelle (catégorie, sexe, rang) à laquelle appartient cette inscription, calculée dans le club porteur ; null sans club" }),
  })
  .openapi("EquipeDetail");

export const clubEquipeSchema = z
  .object({
    id_ffhb: z.string(),
    nom: z.string(),
    engagements: z.array(engagementRefSchema),
    lien: z
      .object({
        methode: z.enum(["licence", "structure", "nom_exact", "nom_reserve", "nom_entente", "groupe"]).openapi({
          description:
            "Signal qui rattache l'équipe au club : structure (le club est porteur), licence (≥ 3 de ses licenciés y jouent), nom_*, groupe (hérité d'une autre inscription de la même équipe réelle, quand celle-ci n'a pas encore de feuille de match)",
        }),
        confiance: z.enum(["haute", "moyenne", "basse"]),
      })
      .optional()
      .openapi({ description: "Comment l'équipe est rattachée au club (ententes où il est partenaire incluses)" }),
  })
  .openapi("ClubEquipe");

export const clubEquipesQuerySchema = saisonQuerySchema.extend({
  include_ententes: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true")
    .openapi({
      description:
        "Inclure les ententes et conventions où le club est partenaire (rattachées à un autre club côté FFHB). Défaut true.",
      example: "true",
    }),
  min_confidence: z
    .enum(["haute", "moyenne", "basse"])
    .optional()
    .openapi({ description: "Confiance minimale du rattachement (absent = toutes)", example: "moyenne" }),
  grouper: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true")
    .openapi({
      description:
        "Regrouper les inscriptions en équipes réelles (catégorie, sexe, rang, entente). Ajoute `meta.groupes` ; `data` reste inchangé.",
      example: "true",
    }),
});

export const groupeEquipesSchema = groupeRefSchema
  .extend({
    equipes: z.array(clubEquipeSchema).openapi({ description: "Les inscriptions FFHB (une par compétition) qui forment cette équipe réelle" }),
    competitions: z.array(competitionRefSchema),
  })
  .openapi("GroupeEquipes");

/** Clé du groupe (équipe réelle) auquel appartient l'élément, dans `meta.groupes`. null si inconnu ou exclu. */
export const groupeCleSchema = z.string().nullable().openapi({ example: "-13|M|1|club", description: "Clé du groupe (voir `meta.groupes`)" });

/** Filtre `?groupe=` : clé d'un groupe de `meta.groupes`. */
export const groupeQuerySchema = z.string().optional().openapi({ example: "-13|M|1|club", description: "Ne garder que ce groupe (clé de `meta.groupes`, voir `/clubs/{id}/equipes?grouper=true`)" });

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
  saison: z.string().regex(/^\d{4}-\d{4}$/).default(() => currentSaison()),
  ...matchFiltersQuery,
  tri: triDateSchema.optional().openapi({ description: "Tri par date de match (défaut : date_asc)" }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
