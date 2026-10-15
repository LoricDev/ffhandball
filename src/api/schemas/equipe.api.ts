// src/api/schemas/equipe.api.ts
import { z } from "@hono/zod-openapi";
import { saisonQuerySchema } from "@/api/schemas/competition.api.js";
import { currentSaison } from "@/lib/saison.js";

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
        "Regrouper les inscriptions en équipes réelles (catégorie, sexe, rang, entente). Ajoute le champ `groupes` ; `data` reste inchangé.",
      example: "true",
    }),
});

export const groupeEquipesSchema = z
  .object({
    cle: z.string().openapi({ example: "-13|M|1|entente", description: "Clé stable du groupe : catégorie|sexe|rang|club ou entente" }),
    categorie: z.enum(["Seniors", "-20", "-19", "-18", "-17", "-15", "-13", "-11", "-9", "-7", "Loisir", "Autre"]),
    sexe: z.enum(["M", "F", "mixte"]),
    rang: z.number().int().positive().openapi({ description: "1 = équipe première ; 2, 3… = équipes réserves (chiffre ou lettre finale du nom)" }),
    entente: z.boolean().openapi({ description: "true si l'équipe est une entente ou une convention entre clubs" }),
    libelle: z.string().openapi({ example: "-13 M — entente" }),
    equipes: z.array(clubEquipeSchema).openapi({ description: "Les inscriptions FFHB (une par compétition) qui forment cette équipe réelle" }),
    competitions: z.array(z.object({ id_ffhb: z.string(), nom: z.string(), niveau: z.string().nullable() })),
  })
  .openapi("GroupeEquipes");

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
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  statut: z.enum(["a_jouer", "joue", "reporte", "annule", "forfait"]).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
