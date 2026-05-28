// src/api/routes/classements.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { classementItemSchema, classementQuerySchema } from "@/api/schemas/classement.api.js";
import { errorResponseSchema } from "@/api/schemas/common.js";
import { getClassementByPoule } from "@/api/lib/repositories/classement.repo.js";

const classements = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/classements",
  tags: ["classements"],
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
      description: "Poule introuvable ou sans classement",
    },
  },
});

classements.openapi(listRoute, async (c) => {
  const { poule_id_ffhb } = c.req.valid("query");
  if (!poule_id_ffhb) {
    return c.json(
      { error: { code: "BAD_REQUEST" as const, message: "Le paramètre poule_id_ffhb est obligatoire" } },
      400,
    );
  }
  const data = await getClassementByPoule(poule_id_ffhb);
  if (data.length === 0) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Poule id_ffhb=${poule_id_ffhb} introuvable ou sans classement` } },
      404,
    );
  }
  return c.json({ data });
});

export default classements;
