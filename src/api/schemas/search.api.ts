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
  type: z
    .enum(["all", "club", "equipe", "joueur", "clubs", "equipes", "joueurs"])
    .default("all")
    .transform((v) => (v === "club" ? "clubs" : v === "equipe" ? "equipes" : v === "joueur" ? "joueurs" : v))
    .openapi({ description: "Type d'entité à chercher, même vocabulaire que `data[].type` (`club`, `equipe`, `joueur`). Les pluriels (`clubs`, `equipes`, `joueurs`) restent acceptés (dépréciés)." }),
  limit: z.coerce.number().int().positive().max(50).default(10),
  saison: z.string().regex(/^\d{4}-\d{4}$/).optional().openapi({ description: "Code saison pour la recherche d'équipes (ex: 2025-2026), défaut : saison courante" }),
});
