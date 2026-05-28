// src/api/routes/clubs.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { clubListItemSchema, clubDetailSchema, clubListQuerySchema } from "@/api/schemas/club.api.js";
import { errorResponseSchema, paginationMetaSchema } from "@/api/schemas/common.js";
import { listClubs, getClubByIdFfhb } from "@/api/lib/repositories/club.repo.js";

const clubs = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/clubs",
  tags: ["clubs"],
  request: { query: clubListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(clubListItemSchema),
            meta: paginationMetaSchema,
          }),
        },
      },
      description: "List of clubs (paginated)",
    },
  },
});

clubs.openapi(listRoute, async (c) => {
  const q = c.req.valid("query");
  const result = await listClubs({
    q: q.q,
    departement: q.departement,
    limit: q.limit,
    offset: q.offset,
  });
  return c.json({
    data: result.data,
    meta: { total: result.total, limit: q.limit, offset: q.offset },
  });
});

const detailRoute = createRoute({
  method: "get",
  path: "/clubs/{id_ffhb}",
  tags: ["clubs"],
  request: { params: z.object({ id_ffhb: z.string() }) },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: clubDetailSchema }) } },
      description: "Club detail",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Club not found",
    },
  },
});

clubs.openapi(detailRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const club = await getClubByIdFfhb(id_ffhb);
  if (!club) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Club id_ffhb=${id_ffhb} introuvable` } },
      404,
    );
  }
  return c.json({ data: club });
});

export default clubs;
