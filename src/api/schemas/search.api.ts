// src/api/schemas/search.api.ts
import { z } from "@hono/zod-openapi";

export const searchResultItemSchema = z.object({
  type: z.enum(["club", "equipe", "joueur"]),
  id_ffhb: z.string(),
  nom: z.string(),
  ville: z.string().nullable(),
  score: z.number(),
}).openapi("SearchResultItem");

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, "Le paramètre q doit contenir au moins 2 caractères").openapi({ description: "Terme de recherche (min 2 chars)", example: "bouzonville" }),
  type: z.enum(["all", "clubs", "equipes", "joueurs"]).default("all").openapi({ description: "Type d'entité à chercher" }),
  limit: z.coerce.number().int().positive().max(50).default(10),
  saison: z.string().regex(/^\d{4}-\d{4}$/).optional().openapi({ description: "Code saison pour la recherche d'équipes (ex: 2025-2026), défaut : saison courante" }),
});
