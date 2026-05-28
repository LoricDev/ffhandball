// src/api/routes/search.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { searchResultItemSchema, searchQuerySchema } from "@/api/schemas/search.api.js";
import { errorResponseSchema } from "@/api/schemas/common.js";
import { search } from "@/api/lib/repositories/search.repo.js";

const searchRouter = new OpenAPIHono();

const searchRoute = createRoute({
  method: "get",
  path: "/search",
  tags: ["search"],
  request: { query: searchQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(searchResultItemSchema),
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
  if (q.length < 2) {
    return c.json(
      { error: { code: "BAD_REQUEST" as const, message: "Le paramètre q doit contenir au moins 2 caractères" } },
      400,
    );
  }
  const data = await search({ q, type, saison, limit });
  return c.json({ data });
});

export default searchRouter;
