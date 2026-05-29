// src/api/routes/clubs.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { clubListItemSchema, clubDetailSchema, clubListQuerySchema } from "@/api/schemas/club.api.js";
import { errorResponseSchema, paginationMetaSchema } from "@/api/schemas/common.js";
import { listClubs, getClubByIdFfhb } from "@/api/lib/repositories/club.repo.js";
import {
  clubMatchItemSchema,
  clubMatchsMetaSchema,
  clubMatchsQuerySchema,
} from "@/api/schemas/club-matchs.api.js";
import { getClubMatchsCalendar } from "@/api/lib/repositories/club-matchs.repo.js";

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
  request: {
    params: z.object({
      id_ffhb: z.string().openapi({
        description: "id_club FFHB (monclub, ex. 1720) OU code FFHB 7 chiffres (ex. 5221105)",
        example: "1720",
      }),
    }),
  },
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

const clubMatchsRoute = createRoute({
  method: "get",
  path: "/clubs/{id_ffhb}/matchs",
  tags: ["clubs"],
  summary: "Calendrier des matchs d'un club (équipe principale, réserves et ententes)",
  description: [
    "Retourne les matchs d'un club pour une saison donnée. Les équipes liées sont détectées",
    "via une **union multi-signal**, chaque équipe taggée `match_method` + `confidence` :",
    "- `licence` (haute) : ≥ 3 licenciés du club ont joué pour l'équipe (capture les ententes via les feuilles de match)",
    "- `structure` (haute) : `equipes.ext_structure_id` = code club",
    "- `nom_exact` (haute) : nom d'équipe = nom du club",
    "- `nom_reserve` (moyenne) : nom du club + suffixe (« X 2 », « X U17 »…)",
    "- `nom_entente` (basse) : entente partageant un mot distinctif (hors mots génériques) avec le club",
    "",
    "`include_ententes=false` exclut les équipes ententes. `min_confidence` filtre par confiance minimale.",
    "Le champ `meta.equipes_liees` détaille chaque lien (transparence et debug).",
  ].join("\n"),
  request: {
    params: z.object({
      id_ffhb: z.string().openapi({
        example: "1720",
        description: "id_club FFHB (monclub) OU code FFHB 7 chiffres (ex. 5221105)",
      }),
    }),
    query: clubMatchsQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(clubMatchItemSchema),
            meta: clubMatchsMetaSchema,
          }),
        },
      },
      description: "Calendrier des matchs du club (trié par date_heure ASC)",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Club non trouvé",
    },
  },
});

clubs.openapi(clubMatchsRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const q = c.req.valid("query");

  const result = await getClubMatchsCalendar({
    id_ffhb,
    saison: q.saison,
    include_ententes: q.include_ententes,
    date_from: q.date_from,
    date_to: q.date_to,
    statut: q.statut,
    min_confidence: q.min_confidence,
    limit: q.limit,
    offset: q.offset,
  });

  if (!result.club) {
    return c.json(
      { error: { code: "NOT_FOUND" as const, message: `Club id_ffhb=${id_ffhb} introuvable` } },
      404,
    );
  }

  return c.json({
    data: result.matchs,
    meta: {
      total: result.total,
      limit: q.limit,
      offset: q.offset,
      club: result.club,
      equipes_liees: result.equipes_liees,
    },
  });
});

export default clubs;
