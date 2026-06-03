// src/api/routes/joueurs.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { joueurDetailSchema, joueurMatchItemSchema } from "@/api/schemas/joueur.api.js";
import { errorResponseSchema, paginationMetaSchema, paginationQuerySchema } from "@/api/schemas/common.js";
import { getJoueurByLicence, getJoueurMatchs } from "@/api/lib/repositories/joueur.repo.js";

const joueurs = new OpenAPIHono();

const detailRoute = createRoute({
  method: "get",
  path: "/joueurs/{numero_licence}",
  tags: ["joueurs"],
  request: { params: z.object({ numero_licence: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: joueurDetailSchema }) } },
      description: "Joueur detail avec stats agrégées et historique 10 derniers matchs",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Joueur not found",
    },
  },
});

joueurs.openapi(detailRoute, async (c) => {
  const { numero_licence } = c.req.valid("param");
  const joueur = await getJoueurByLicence(numero_licence);
  if (!joueur) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Joueur numero_licence=${numero_licence} introuvable` } },
      404,
    );
  }
  return c.json({ data: joueur }, 200);
});

const matchsRoute = createRoute({
  method: "get",
  path: "/joueurs/{numero_licence}/matchs",
  tags: ["joueurs"],
  summary: "Historique complet (paginé) des matchs d'un joueur",
  request: {
    params: z.object({ numero_licence: z.string() }),
    query: paginationQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(joueurMatchItemSchema), meta: paginationMetaSchema }),
        },
      },
      description: "Matchs du joueur (triés par date_heure ASC)",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Joueur not found" },
  },
});

joueurs.openapi(matchsRoute, async (c) => {
  const { numero_licence } = c.req.valid("param");
  const q = c.req.valid("query");
  const result = await getJoueurMatchs(numero_licence, q.limit, q.offset);
  if (!result) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Joueur numero_licence=${numero_licence} introuvable` } },
      404,
    );
  }
  return c.json({ data: result.data, meta: { total: result.total, limit: q.limit, offset: q.offset } }, 200);
});

export default joueurs;
