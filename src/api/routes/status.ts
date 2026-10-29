// src/api/routes/status.ts — /status (JSON, public) et /statut (page publique).
import { readFileSync } from "node:fs";
import { newRouter } from "@/api/lib/router.js";
import { createRoute, z } from "@hono/zod-openapi";
import { getStatus } from "@/api/lib/repositories/status.repo.js";

const status = newRouter();

const integriteSchema = z.object({
  key: z.string().openapi({ example: "poules" }),
  label: z.string().openapi({ example: "Poules présentes" }),
  ok: z.boolean(),
  gravite: z.enum(["panne", "degrade"]).openapi({ description: "Statut global induit si le contrôle échoue" }),
});

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
    "Public, sans clé API. `statut` : operationnel (tout est à jour), degrade (jeu de données en retard ou garde de la base manquante), panne (base indisponible, table clé vide ou matchs sans poule).",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            statut: z.enum(["operationnel", "degrade", "panne"]),
            verifie_le: z.string(),
            base_de_donnees: z.enum(["connectee", "indisponible"]),
            donnees: z.array(datasetSchema),
            integrite: z.array(integriteSchema).openapi({ description: "Contrôles d'intégrité de la base (tables clés non vides, matchs rattachés à une poule, contrainte en place)" }),
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
