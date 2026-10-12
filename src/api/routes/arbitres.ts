// src/api/routes/arbitres.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  arbitreListItemSchema,
  arbitreMatchItemSchema,
  arbitreDetailSchema,
  arbitreListQuerySchema,
} from "@/api/schemas/arbitre.api.js";
import { paginationMetaSchema, paginationQuerySchema, errorResponseSchema } from "@/api/schemas/common.js";
import { listArbitres, getArbitreMatchs, getArbitreDetail } from "@/api/lib/repositories/arbitre.repo.js";

const arbitres = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/arbitres",
  tags: ["arbitres"],
  summary: "Liste des arbitres (recherche floue + filtre niveau)",
  request: { query: arbitreListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(arbitreListItemSchema), meta: paginationMetaSchema }),
        },
      },
      description: "Liste paginée des arbitres",
    },
  },
});

arbitres.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  const { data, total } = await listArbitres({ q: q.q, niveau: q.niveau, limit: q.limit, offset: q.offset });
  return c.json({ data, meta: { total, limit: q.limit, offset: q.offset } });
});

const detailRoute = createRoute({
  method: "get",
  path: "/arbitres/{id_ffhb}",
  tags: ["arbitres"],
  summary: "Détail d'un arbitre (+ nombre de matchs arbitrés)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "286170", description: "Identifiant FFHB de l'arbitre" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: arbitreDetailSchema }) } },
      description: "Détail de l'arbitre",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Arbitre introuvable" },
  },
});

arbitres.openapi(detailRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const data = await getArbitreDetail(id_ffhb);
  if (!data) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Arbitre id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data }, 200);
});

const matchsRoute = createRoute({
  method: "get",
  path: "/arbitres/{id_ffhb}/matchs",
  tags: ["arbitres"],
  summary: "Matchs arbitrés par un arbitre",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "286170", description: "Identifiant FFHB de l'arbitre" }) }),
    query: paginationQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(arbitreMatchItemSchema), meta: paginationMetaSchema }),
        },
      },
      description: "Matchs arbitrés (triés par date_heure ASC)",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Arbitre introuvable" },
  },
});

arbitres.openapi(matchsRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const q = c.req.valid("query");
  const result = await getArbitreMatchs(id_ffhb, q.limit, q.offset);
  if (!result) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Arbitre id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data: result.data, meta: { total: result.total, limit: q.limit, offset: q.offset } }, 200);
});

export default arbitres;
