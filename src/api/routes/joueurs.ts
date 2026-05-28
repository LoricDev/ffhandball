// src/api/routes/joueurs.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { joueurDetailSchema } from "@/api/schemas/joueur.api.js";
import { errorResponseSchema } from "@/api/schemas/common.js";
import { getJoueurByLicence } from "@/api/lib/repositories/joueur.repo.js";

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
  return c.json({ data: joueur });
});

export default joueurs;
