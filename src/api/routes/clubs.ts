// src/api/routes/clubs.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { clubListItemSchema, clubDetailSchema, clubListQuerySchema, clubClassementItemSchema } from "@/api/schemas/club.api.js";
import { errorResponseSchema, paginationMetaSchema } from "@/api/schemas/common.js";
import { listClubs, getClubByIdFfhb, listClubJoueurs, listClubClassements } from "@/api/lib/repositories/club.repo.js";
import { rosterJoueurItemSchema } from "@/api/schemas/equipe.api.js";
import {
  clubMatchItemSchema,
  clubMatchsMetaSchema,
  clubMatchsQuerySchema,
} from "@/api/schemas/club-matchs.api.js";
import { getClubMatchsCalendar } from "@/api/lib/repositories/club-matchs.repo.js";
import { clubEquipeSchema } from "@/api/schemas/equipe.api.js";
import { saisonQuerySchema } from "@/api/schemas/competition.api.js";
import { listClubEquipes } from "@/api/lib/repositories/equipe.repo.js";

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

const clubEquipesRoute = createRoute({
  method: "get",
  path: "/clubs/{id_ffhb}/equipes",
  tags: ["clubs"],
  summary: "Équipes propres d'un club (pont autoritatif ext_structure_id = id_ffhb)",
  request: {
    params: z.object({
      id_ffhb: z.string().openapi({ example: "1720", description: "id_club FFHB OU code FFHB 7 chiffres" }),
    }),
    query: saisonQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(clubEquipeSchema),
            meta: z.object({
              club: z.object({ id_ffhb: z.string(), code_ffhb: z.string().nullable(), nom: z.string() }),
            }),
          }),
        },
      },
      description: "Équipes du club (avec leurs engagements)",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Club introuvable" },
  },
});

clubs.openapi(clubEquipesRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const { saison } = c.req.valid("query");
  const club = await getClubByIdFfhb(id_ffhb); // résout par id_ffhb OU code_ffhb
  if (!club) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Club id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  const data = await listClubEquipes(club.id_ffhb, saison);
  return c.json({ data, meta: { club: { id_ffhb: club.id_ffhb, code_ffhb: club.code_ffhb, nom: club.nom } } });
});

const clubJoueursRoute = createRoute({
  method: "get",
  path: "/clubs/{id_ffhb}/joueurs",
  tags: ["clubs"],
  summary: "Joueurs licenciés d'un club (préfixe licence = code FFHB)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "1720", description: "id_club FFHB OU code FFHB 7 chiffres" }) }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(rosterJoueurItemSchema),
            meta: z.object({
              club: z.object({ id_ffhb: z.string(), code_ffhb: z.string().nullable(), nom: z.string() }),
            }),
          }),
        },
      },
      description: "Joueurs licenciés du club (avec matchs/buts joués). Vide si code_ffhb inconnu.",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Club introuvable" },
  },
});

clubs.openapi(clubJoueursRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const club = await getClubByIdFfhb(id_ffhb);
  if (!club) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Club id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  const data = await listClubJoueurs(club.code_ffhb);
  return c.json({ data, meta: { club: { id_ffhb: club.id_ffhb, code_ffhb: club.code_ffhb, nom: club.nom } } });
});

const clubClassementsRoute = createRoute({
  method: "get",
  path: "/clubs/{id_ffhb}/classements",
  tags: ["clubs"],
  summary: "Classements de toutes les équipes du club (dernier snapshot)",
  request: {
    params: z.object({ id_ffhb: z.string().openapi({ example: "1720" }) }),
    query: saisonQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(clubClassementItemSchema),
            meta: z.object({
              club: z.object({ id_ffhb: z.string(), code_ffhb: z.string().nullable(), nom: z.string() }),
            }),
          }),
        },
      },
      description: "Positions des équipes du club dans leurs poules",
    },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Club introuvable" },
  },
});

clubs.openapi(clubClassementsRoute, async (c) => {
  const { id_ffhb } = c.req.valid("param");
  const { saison } = c.req.valid("query");
  const club = await getClubByIdFfhb(id_ffhb);
  if (!club) {
    return c.json({ error: { code: "NOT_FOUND" as const, message: `Club id_ffhb=${id_ffhb} introuvable` } }, 404);
  }
  const data = await listClubClassements(club.id_ffhb, saison);
  return c.json({ data, meta: { club: { id_ffhb: club.id_ffhb, code_ffhb: club.code_ffhb, nom: club.nom } } });
});

export default clubs;
