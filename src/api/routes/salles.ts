// src/api/routes/salles.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { salleDetailSchema, salleMatchsQuerySchema } from "@/api/schemas/salle.api.js";
import { matchListItemSchema } from "@/api/schemas/match.api.js";
import { paginationMetaSchema, errorResponseSchema } from "@/api/schemas/common.js";
import { getSalleByIdFfhb, getSalleMatchs } from "@/api/lib/repositories/salle.repo.js";

const salles = new OpenAPIHono();

const detailRoute = createRoute({
  method: "get",
  path: "/salles/{id_ffhb}",
  tags: ["salles"],
  summary: "Détail d'une salle",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "5655", description: "Identifiant FFHB de la salle" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: salleDetailSchema }) } },
      description: "Détail de la salle",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Salle introuvable" },
  },
});

salles.openapi(detailRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const data = await getSalleByIdFfhb(id_ffhb);
  if (!data) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Salle id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data });
});

const matchsRoute = createRoute({
  method: "get",
  path: "/salles/{id_ffhb}/matchs",
  tags: ["salles"],
  summary: "Matchs accueillis par une salle",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "5655" }) }),
    query: salleMatchsQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(matchListItemSchema), meta: paginationMetaSchema }),
        },
      },
      description: "Matchs accueillis (triés par date_heure ASC)",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Salle introuvable" },
  },
});

salles.openapi(matchsRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const q = c.req.valid("query");
  const result = await getSalleMatchs(id_ffhb, {
    date_from: q.date_from,
    date_to: q.date_to,
    statut: q.statut,
    limit: q.limit,
    offset: q.offset,
  });
  if (!result) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Salle id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data: result.data, meta: { total: result.total, limit: q.limit, offset: q.offset } });
});

export default salles;
