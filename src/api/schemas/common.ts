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
