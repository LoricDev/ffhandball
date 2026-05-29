// src/api/schemas/stats-joueurs.api.ts
import { z } from "@hono/zod-openapi";

export const statsJoueurItemSchema = z
  .object({
    nom: z.string(),
    prenom: z.string(),
    equipe_libelle: z.string().nullable(),
    match_count: z.number().int(),
    total_buts: z.number().int(),
    total_arrets: z.number().int(),
  })
  .openapi("StatsJoueurItem");

export const statsJoueursQuerySchema = z.object({
  poule_id_ffhb: z.string().optional().openapi({ description: "Identifiant FFHB de la poule (obligatoire)" }),
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});
