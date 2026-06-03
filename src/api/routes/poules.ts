// src/api/routes/poules.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { pouleDetailSchema, saisonQuerySchema } from "@/api/schemas/competition.api.js";
import { errorResponseSchema } from "@/api/schemas/common.js";
import { getPouleDetail } from "@/api/lib/repositories/competition.repo.js";

const poules = new OpenAPIHono();

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

export default poules;
