// src/api/schemas/common.ts
import { z } from "@hono/zod-openapi";

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum([
        "BAD_REQUEST",
        "UNAUTHORIZED",
        "NOT_FOUND",
        "RATE_LIMIT_EXCEEDED",
        "INTERNAL_ERROR",
        "SERVICE_UNAVAILABLE",
      ]),
      message: z.string(),
      details: z.unknown().optional(),
      request_id: z.string().optional().openapi({ description: "Identifiant de requête (en-tête X-Request-Id), à communiquer en cas de 500" }),
    }),
  })
  .openapi("ErrorResponse");

export const paginationMetaSchema = z
  .object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .openapi("PaginationMeta");

/** Pagination + saison réellement utilisée (null = toutes les saisons, pour /matchs sans filtre). */
export const paginationMetaWithSaisonSchema = paginationMetaSchema
  .extend({ saison: z.string().nullable().openapi({ example: "2026-2027", description: "Saison utilisée pour cette réponse (null = toutes les saisons)" }) })
  .openapi("PaginationMetaWithSaison");

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

/** Date ISO 8601 en paramètre de requête : rejetée en 400 plutôt que de provoquer une erreur SQL (500). */
export const isoDateParamSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Date ISO 8601 invalide (ex: 2026-01-31 ou 2026-01-31T18:00:00Z)" })
  .openapi({ example: "2026-01-31T00:00:00Z" });

export const matchStatutSchema = z
  .enum(["a_jouer", "joue", "reporte", "annule", "forfait"])
  .openapi({ description: "Statut du match" });

export const saisonCodeSchema = z.string().regex(/^\d{4}-\d{4}$/).openapi({ example: "2026-2027" });

/** Ordre chronologique des matchs. */
export const triDateSchema = z
  .enum(["date_asc", "date_desc"])
  .openapi({ description: "Tri par date de match (défaut propre à chaque endpoint)" });
