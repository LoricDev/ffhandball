// src/api/routes/search.ts
import { currentSaison } from "@/lib/saison.js";
import { newRouter } from "@/api/lib/router.js";
import { createRoute, z } from "@hono/zod-openapi";
import { searchResultItemSchema, searchQuerySchema } from "@/api/schemas/search.api.js";
import { errorResponseSchema } from "@/api/schemas/common.js";
import { search } from "@/api/lib/repositories/search.repo.js";

const searchRouter = newRouter();

const searchRoute = createRoute({
  method: "get",
  path: "/search",
  tags: ["search"],
  summary: "Recherche floue multi-entités (clubs, équipes, joueurs)",
  request: { query: searchQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(searchResultItemSchema),
            meta: z.object({ saison: z.string().openapi({ description: "Saison utilisée pour la recherche d'équipes" }) }),
          }),
        },
      },
      description: "Résultats de recherche fuzzy multi-entités",
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Paramètre q invalide (< 2 chars)",
    },
  },
});

searchRouter.openapi(searchRoute, async (c) => {
  const { q, type, limit, saison } = c.req.valid("query");
  const data = await search({ q, type, saison, limit });
  return c.json({ data, meta: { saison: saison ?? currentSaison() } }, 200);
});

export default searchRouter;
