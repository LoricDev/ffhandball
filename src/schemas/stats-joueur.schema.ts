// src/schemas/stats-joueur.schema.ts
import { z } from "zod";

const intFromStringOrNumber = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  },
  z.number().int().nonnegative(),
);

export const rawStatsJoueurPayloadSchema = z.object({
  ext_poule_id: z.string().min(1),
  individu_id: z.string().min(1),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  equipe_libelle: z.string().min(1),
  // Id d'équipe résolu via equipe_options de la poule (résolution fiable côté ETL ; optionnel
  // pour rester compatible avec les anciennes lignes raw scrapées sans cet id).
  ext_equipe_id: z.string().optional(),
  match_count: intFromStringOrNumber,
  total_buts: intFromStringOrNumber,
  total_arrets: intFromStringOrNumber,
  source_url: z.string().url(),
});
export type RawStatsJoueurPayload = z.infer<typeof rawStatsJoueurPayloadSchema>;
