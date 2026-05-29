// src/api/routes/referentiels.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { saisonItemSchema, referentielItemSchema } from "@/api/schemas/referentiel.api.js";
import { listSaisons, listDepartements, listLigues } from "@/api/lib/repositories/referentiel.repo.js";

const referentiels = new OpenAPIHono();

const saisonsRoute = createRoute({
  method: "get",
  path: "/saisons",
  tags: ["referentiels"],
  summary: "Liste des saisons disponibles (la plus récente en premier)",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(saisonItemSchema) }) } },
      description: "Saisons",
    },
  },
});
referentiels.openapi(saisonsRoute, async (c) => c.json({ data: await listSaisons() }));

const departementsRoute = createRoute({
  method: "get",
  path: "/departements",
  tags: ["referentiels"],
  summary: "Liste des départements",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(referentielItemSchema) }) } },
      description: "Départements",
    },
  },
});
referentiels.openapi(departementsRoute, async (c) => c.json({ data: await listDepartements() }));

const liguesRoute = createRoute({
  method: "get",
  path: "/ligues",
  tags: ["referentiels"],
  summary: "Liste des ligues",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(referentielItemSchema) }) } },
      description: "Ligues",
    },
  },
});
referentiels.openapi(liguesRoute, async (c) => c.json({ data: await listLigues() }));

export default referentiels;
