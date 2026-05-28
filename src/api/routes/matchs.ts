// src/api/routes/matchs.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { matchListItemSchema, matchDetailSchema, matchListQuerySchema } from "@/api/schemas/match.api.js";
import { errorResponseSchema, paginationMetaSchema } from "@/api/schemas/common.js";
import { listMatchs, getMatchDetail } from "@/api/lib/repositories/match.repo.js";

const matchs = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/matchs",
  tags: ["matchs"],
  request: { query: matchListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(matchListItemSchema),
            meta: paginationMetaSchema,
          }),
        },
      },
      description: "List of matchs (paginated)",
    },
  },
});

matchs.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  const result = await listMatchs({
    poule_id_ffhb: q.poule_id_ffhb,
    date_from: q.date_from,
    date_to: q.date_to,
    statut: q.statut,
    limit: q.limit,
    offset: q.offset,
  });
  return c.json({
    data: result.data,
    meta: { total: result.total, limit: q.limit, offset: q.offset },
  });
});

const detailRoute = createRoute({
  method: "get",
  path: "/matchs/{id_ffhb_match}",
  tags: ["matchs"],
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
  return c.json({ data: match });
});

export default matchs;
