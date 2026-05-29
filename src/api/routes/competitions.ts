// src/api/routes/competitions.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  competitionListItemSchema,
  competitionDetailSchema,
  competitionListQuerySchema,
} from "@/api/schemas/competition.api.js";
import { paginationMetaSchema, errorResponseSchema } from "@/api/schemas/common.js";
import { listCompetitions, getCompetitionDetail } from "@/api/lib/repositories/competition.repo.js";

const competitions = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/competitions",
  tags: ["competitions"],
  summary: "Liste des compétitions (filtres saison/niveau/sexe + recherche floue)",
  request: { query: competitionListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(competitionListItemSchema), meta: paginationMetaSchema }),
        },
      },
      description: "Liste paginée des compétitions",
    },
  },
});

competitions.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  const { data, total } = await listCompetitions({
    saison: q.saison,
    niveau: q.niveau,
    sexe: q.sexe,
    q: q.q,
    limit: q.limit,
    offset: q.offset,
  });
  return c.json({ data, meta: { total, limit: q.limit, offset: q.offset } });
});

const detailRoute = createRoute({
  method: "get",
  path: "/competitions/{id_ffhb}",
  tags: ["competitions"],
  summary: "Détail d'une compétition avec ses phases et poules",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "28227", description: "Identifiant FFHB de la compétition" }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: competitionDetailSchema }) } },
      description: "Détail de la compétition (phases + poules imbriquées)",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Compétition introuvable",
    },
  },
});

competitions.openapi(detailRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const data = await getCompetitionDetail(id_ffhb);
  if (!data) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Compétition id_ffhb=${id_ffhb} introuvable` } },
      404,
    );
  }
  return c.json({ data });
});

export default competitions;
