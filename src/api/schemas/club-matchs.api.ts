// src/api/schemas/club-matchs.api.ts
import { z } from "@hono/zod-openapi";

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
  })
  .openapi("EquipeLiee");

export const clubMatchItemSchema = z
  .object({
    id_ffhb_match: z.string().openapi({ example: "M-12345", description: "Identifiant FFHB du match" }),
    date_heure: z
      .union([z.string(), z.date()])
      .transform((v) => (v instanceof Date ? v.toISOString() : v))
      .openapi({ example: "2026-09-03T20:00:00.000Z", description: "Date et heure du match (ISO 8601)" }),
    statut: z
      .string()
      .openapi({ example: "joue", description: "Statut du match : joue, a_jouer, reporte, annule, forfait" }),
    journee: z.number().int().nullable().openapi({ example: 1, description: "Numéro de journée" }),
    equipe_dom_nom: z.string().openapi({ example: "BREST BRETAGNE HANDBALL", description: "Équipe domicile" }),
    equipe_ext_nom: z.string().openapi({ example: "PARIS 92", description: "Équipe extérieure" }),
    score_dom: z.number().int().nullable().openapi({ example: 28, description: "Score domicile (null si non joué)" }),
    score_ext: z.number().int().nullable().openapi({ example: 25, description: "Score extérieur (null si non joué)" }),
    poule_id_ffhb: z.string().openapi({ example: "PO-001", description: "Identifiant FFHB de la poule" }),
    competition_nom: z.string().openapi({ example: "Lidl Starligue", description: "Nom de la compétition" }),
    fdm_url: z
      .string()
      .nullable()
      .openapi({ example: "https://fdm.ffhandball.fr/...", description: "URL feuille de match PDF" }),
    club_recevant: z
      .boolean()
      .openapi({ description: "True si le club joue ce match à domicile (équipe liée est l'équipe dom)" }),
    via_entente: z
      .boolean()
      .openapi({ description: "True si ce match est lié au club via une équipe entente" }),
    via_principal: z
      .boolean()
      .openapi({ description: "True si ce match est lié au club via son équipe principale (vs réserve ou entente)" }),
  })
  .openapi("ClubMatchItem");

export const clubMatchsQuerySchema = z.object({
  saison: z
    .string()
    .regex(/^\d{4}-\d{4}$/)
    .default("2025-2026")
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
  date_from: z
    .string()
    .optional()
    .openapi({
      description: "Filtre date de début (ISO 8601, ex: 2025-09-01)",
      example: "2025-09-01",
    }),
  date_to: z
    .string()
    .optional()
    .openapi({
      description: "Filtre date de fin (ISO 8601, ex: 2026-06-30)",
      example: "2026-06-30",
    }),
  statut: z
    .enum(["a_jouer", "joue", "reporte", "annule", "forfait"])
    .optional()
    .openapi({
      description: "Filtre sur le statut du match",
      example: "joue",
    }),
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
    club: z
      .object({
        id_ffhb: z.string(),
        nom: z.string(),
      })
      .openapi({ description: "Informations du club" }),
    equipes_liees: z
      .array(equipeLieeSchema)
      .openapi({
        description:
          "Liste des équipes identifiées comme appartenant au club (transparence sur le matching textuel)",
      }),
  })
  .openapi("ClubMatchsMeta");
