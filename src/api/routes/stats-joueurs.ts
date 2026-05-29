// src/api/routes/stats-joueurs.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { statsJoueurItemSchema, statsJoueursQuerySchema } from "@/api/schemas/stats-joueurs.api.js";
import { paginationMetaSchema, errorResponseSchema } from "@/api/schemas/common.js";
import { getStatsJoueursByPoule } from "@/api/lib/repositories/stats-joueurs.repo.js";

const statsJoueurs = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/stats-joueurs",
  tags: ["stats-joueurs"],
  summary: "Stats joueurs d'une poule (dernier snapshot, ordonné par buts)",
  request: { query: statsJoueursQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(statsJoueurItemSchema), meta: paginationMetaSchema }),
        },
      },
      description: "Classement des buteurs/stats de la poule",
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Paramètre poule_id_ffhb manquant",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Poule introuvable ou sans stats joueurs",
    },
  },
});

statsJoueurs.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  if (!q.poule_id_ffhb) {
    return c.json(
      { error: { code: "BAD_REQUEST" as const, message: "Le paramètre poule_id_ffhb est obligatoire" } },
      400,
    );
  }
  const { data, total } = await getStatsJoueursByPoule(q.poule_id_ffhb, q.limit, q.offset);
  if (total === 0) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Poule id_ffhb=${q.poule_id_ffhb} introuvable ou sans stats joueurs` } },
      404,
    );
  }
  return c.json({ data, meta: { total, limit: q.limit, offset: q.offset } });
});

export default statsJoueurs;
