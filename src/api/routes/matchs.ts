// src/api/routes/matchs.ts
import { newRouter } from "@/api/lib/router.js";
import { createRoute, z } from "@hono/zod-openapi";
import { matchListItemSchema, matchDetailSchema, matchListQuerySchema } from "@/api/schemas/match.api.js";
import { errorResponseSchema, paginationMetaWithSaisonSchema } from "@/api/schemas/common.js";
import { listMatchs, getMatchDetail } from "@/api/lib/repositories/match.repo.js";

const matchs = newRouter();

const listRoute = createRoute({
  method: "get",
  path: "/matchs",
  tags: ["matchs"],
  summary: "Liste des matchs (filtres poule, compétition, équipe, club, salle, journée, dates, statut, saison)",
  request: { query: matchListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(matchListItemSchema),
            meta: paginationMetaWithSaisonSchema,
          }),
        },
      },
      description: "Liste paginée de matchs (tri par défaut : date décroissante)",
    },
  },
});

matchs.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  const { limit, offset, ...filters } = q;
  const result = await listMatchs({ ...filters, limit, offset });
  return c.json({
    data: result.data,
    meta: { total: result.total, limit: q.limit, offset: q.offset, saison: q.saison ?? null },
  });
});

const detailRoute = createRoute({
  method: "get",
  path: "/matchs/{id_ffhb_match}",
  tags: ["matchs"],
  summary: "Détail d'un match (compositions, actions, officiels)",
  request: { params: z.object({ id_ffhb_match: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: matchDetailSchema }) } },
      description: "Match detail enrichi (compositions + actions + officiels)",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Match not found",
    },
  },
});

matchs.openapi(detailRoute, async (c) => {
  const { id_ffhb_match } = c.req.valid("param");
  const match = await getMatchDetail(id_ffhb_match);
  if (!match) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Match id_ffhb_match=${id_ffhb_match} introuvable` } },
      404,
    );
  }
  return c.json({ data: match }, 200);
});

export default matchs;
