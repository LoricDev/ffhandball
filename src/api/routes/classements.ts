// src/api/routes/classements.ts
import { newRouter } from "@/api/lib/router.js";
import { createRoute, z } from "@hono/zod-openapi";
import { classementItemSchema, classementQuerySchema } from "@/api/schemas/classement.api.js";
import { errorResponseSchema } from "@/api/schemas/common.js";
import { pouleExists } from "@/api/lib/repositories/match.repo.js";
import { getClassementByPoule } from "@/api/lib/repositories/classement.repo.js";

const classements = newRouter();

const listRoute = createRoute({
  method: "get",
  path: "/classements",
  tags: ["classements"],
  summary: "Classement d'une poule",
  request: { query: classementQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(classementItemSchema),
          }),
        },
      },
      description: "Classement d'une poule (ordonné par position ASC)",
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Paramètre poule_id_ffhb manquant",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Poule introuvable (une poule sans classement renvoie 200 avec une liste vide)",
    },
  },
});

classements.openapi(listRoute, async (c) => {
  const { poule_id_ffhb } = c.req.valid("query");
  const data = await getClassementByPoule(poule_id_ffhb);
  if (data.length === 0 && !(await pouleExists(poule_id_ffhb))) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Poule id_ffhb=${poule_id_ffhb} introuvable` } }, 404);
  }
  return c.json({ data }, 200);
});

export default classements;
