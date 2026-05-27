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
});

export type RawCompetitionPayload = z.infer<typeof rawCompetitionPayloadSchema>;
