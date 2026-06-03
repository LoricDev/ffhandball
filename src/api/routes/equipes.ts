// src/api/routes/equipes.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { equipeDetailSchema, equipeMatchsQuerySchema, rosterJoueurItemSchema } from "@/api/schemas/equipe.api.js";
import { matchListItemSchema } from "@/api/schemas/match.api.js";
import { saisonQuerySchema } from "@/api/schemas/competition.api.js";
import { paginationMetaSchema, errorResponseSchema } from "@/api/schemas/common.js";
import { getEquipeDetail, getEquipeMatchs, getEquipeJoueurs } from "@/api/lib/repositories/equipe.repo.js";

const equipes = new OpenAPIHono();

const detailRoute = createRoute({
  method: "get",
  path: "/equipes/{id_ffhb}",
  tags: ["equipes"],
  summary: "Détail d'une équipe (club + engagements)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "1949483", description: "Identifiant FFHB de l'équipe" }) }),
    query: saisonQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: equipeDetailSchema }) } },
      description: "Détail de l'équipe",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Équipe introuvable" },
  },
});

equipes.openapi(detailRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const { saison } = c.req.valid("query");
  const data = await getEquipeDetail(id_ffhb, saison);
  if (!data) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Équipe id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data }, 200);
});

const matchsRoute = createRoute({
  method: "get",
  path: "/equipes/{id_ffhb}/matchs",
  tags: ["equipes"],
  summary: "Matchs d'une équipe (domicile + extérieur)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "1949483" }) }),
    query: equipeMatchsQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(matchListItemSchema), meta: paginationMetaSchema }),
        },
      },
      description: "Matchs de l'équipe (triés par date_heure ASC)",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Équipe introuvable" },
  },
});

equipes.openapi(matchsRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const q = c.req.valid("query");
  const result = await getEquipeMatchs(id_ffhb, q.saison, {
    date_from: q.date_from,
    date_to: q.date_to,
    statut: q.statut,
    limit: q.limit,
    offset: q.offset,
  });
  if (!result) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Équipe id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data: result.data, meta: { total: result.total, limit: q.limit, offset: q.offset } }, 200);
});

const joueursRoute = createRoute({
  method: "get",
  path: "/equipes/{id_ffhb}/joueurs",
  tags: ["equipes"],
  summary: "Effectif d'une équipe (joueurs distincts via feuilles de match)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "1949483" }) }),
    query: saisonQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(rosterJoueurItemSchema) }) } },
      description: "Joueurs ayant joué pour l'équipe (triés par buts décroissants)",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Équipe introuvable" },
  },
});

equipes.openapi(joueursRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const { saison } = c.req.valid("query");
  const data = await getEquipeJoueurs(id_ffhb, saison);
  if (!data) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Équipe id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data }, 200);
});

export default equipes;
