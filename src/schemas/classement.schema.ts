// src/schemas/classement.schema.ts
import { z } from "zod";

// Helper preprocess pour gérer strings et numbers (source ffhandball.fr expose en strings)
const intFromStringOrNumber = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  },
  z.number().int(),
);

export const rawClassementPayloadSchema = z.object({
  ext_classement_id: z.string().min(1),
  ext_poule_id: z.string().min(1),
  ext_equipe_id: z.string().min(1),

  position: intFromStringOrNumber,
  points: intFromStringOrNumber,
  joues: intFromStringOrNumber,
  gagnes: intFromStringOrNumber,
  nuls: intFromStringOrNumber,
  perdus: intFromStringOrNumber,
  buts_pour: intFromStringOrNumber,
  buts_contre: intFromStringOrNumber,

  dernieres_rencontres: z.string().optional(),

  source_url: z.string().url(),
});
export type RawClassementPayload = z.infer<typeof rawClassementPayloadSchema>;
