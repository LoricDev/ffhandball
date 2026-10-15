// src/api/routes/poules.ts
import { newRouter } from "@/api/lib/router.js";
import { createRoute, z } from "@hono/zod-openapi";
import { pouleDetailSchema, saisonQuerySchema } from "@/api/schemas/competition.api.js";
import { errorResponseSchema, paginationMetaSchema, triDateSchema } from "@/api/schemas/common.js";
import { matchFiltersQuery, matchListItemSchema } from "@/api/schemas/match.api.js";
import { listMatchs, pouleExists } from "@/api/lib/repositories/match.repo.js";
import { getPouleDetail } from "@/api/lib/repositories/competition.repo.js";

const poules = newRouter();

const detailRoute = createRoute({
  method: "get",
  path: "/poules/{id_ffhb}",
  tags: ["competitions"],
  summary: "Détail d'une poule (contexte compétition/phase + classement)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "168256", description: "Identifiant FFHB de la poule" }) }),
    query: saisonQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: pouleDetailSchema }) } },
      description: "Détail de la poule (classement inline ; matchs via /matchs?poule_id_ffhb=)",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Poule introuvable",
    },
  },
});

poules.openapi(detailRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const { saison } = c.req.valid("query");
  const data = await getPouleDetail(id_ffhb, saison);
  if (!data) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Poule id_ffhb=${id_ffhb} introuvable` } },
      404,
    );
  }
  return c.json({ data }, 200);
});

const pouleMatchsRoute = createRoute({
  method: "get",
  path: "/poules/{id_ffhb}/matchs",
  tags: ["competitions"],
  summary: "Matchs d'une poule (calendrier et résultats)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "168256", description: "Identifiant FFHB de la poule" }) }),
    query: z.object({
      ...matchFiltersQuery,
      tri: triDateSchema.optional().openapi({ description: "Tri par date de match (défaut : date_asc)" }),
      limit: z.coerce.number().int().positive().max(100).default(20),
      offset: z.coerce.number().int().nonnegative().default(0),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(matchListItemSchema), meta: paginationMetaSchema }) } },
      description: "Matchs de la poule (triés par date croissante par défaut)",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Poule introuvable" },
  },
});

poules.openapi(pouleMatchsRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const { limit, offset, tri, ...filters } = c.req.valid("query");
  if (!(await pouleExists(id_ffhb))) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Poule id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  const result = await listMatchs({ ...filters, poule_id_ffhb: id_ffhb, tri: tri ?? "date_asc", limit, offset });
  return c.json({ data: result.data, meta: { total: result.total, limit, offset } }, 200);
});

export default poules;
