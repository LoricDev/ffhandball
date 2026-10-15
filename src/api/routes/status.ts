// src/api/routes/status.ts — /status (JSON, public) et /statut (page publique).
import { readFileSync } from "node:fs";
import { newRouter } from "@/api/lib/router.js";
import { createRoute, z } from "@hono/zod-openapi";
import { getStatus } from "@/api/lib/repositories/status.repo.js";

const status = newRouter();

const datasetSchema = z.object({
  key: z.string().openapi({ example: "matchs" }),
  label: z.string().openapi({ example: "Matchs et résultats" }),
  derniere_maj: z.string().nullable().openapi({ description: "Dernière mise à jour réussie (ISO 8601)" }),
  age_heures: z.number().nullable(),
  etat: z.enum(["ok", "retard", "inconnu"]),
});

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["health"],
  summary: "État du service et fraîcheur des données",
  description:
    "Public, sans clé API. `statut` : operationnel (tout est à jour), degrade (au moins un jeu de données en retard), panne (base indisponible).",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            statut: z.enum(["operationnel", "degrade", "panne"]),
            verifie_le: z.string(),
            base_de_donnees: z.enum(["connectee", "indisponible"]),
            donnees: z.array(datasetSchema),
          }),
        },
      },
      description: "État courant",
    },
  },
});

status.openapi(statusRoute, async (c) => {
  c.header("Cache-Control", "public, max-age=30");
  return c.json(await getStatus(), 200);
});

// Page publique, même origine que l'API : pas de CORS ni de CSP à gérer.
const PAGE = readFileSync(new URL("../public/statut.html", import.meta.url), "utf8");
status.get("/statut", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.html(PAGE);
});

export default status;
