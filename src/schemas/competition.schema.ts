// src/schemas/competition.schema.ts
import { z } from "zod";

export const rawCompetitionPayloadSchema = z.object({
  ext_competition_id: z.string().min(1),
  nom: z.string().min(1),
  niveau: z.enum(["national", "regional", "departemental"]),
  sexe: z.enum(["M", "F", "mixte"]).optional(),
  code: z.string().optional(),
  ext_structure_id: z.string().optional(),
  detail_url: z.string().url(),
  source_url: z.string().url(),
  afficher_stats_joueurs: z
    .preprocess(
      (v) => {
        // Source ffhandball.fr expose "0" / "1" / "true" / "false" / boolean / undefined
        if (v === null || v === undefined || v === "") return undefined;
        if (typeof v === "boolean") return v;
        if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
        if (typeof v === "number") return v === 1;
        return undefined;
      },
      z.boolean(),
    )
    .optional(),
});

export type RawCompetitionPayload = z.infer<typeof rawCompetitionPayloadSchema>;
