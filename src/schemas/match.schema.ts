// src/schemas/match.schema.ts
import { z } from "zod";

// La source ffhandball.fr expose les scores comme strings ("33") quand remplis
// ou null quand absents. Ce helper gère les 3 cas : string numeric, number, null.
const nullableIntFromStringOrNumber = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  },
  z.number().int().nullable(),
);

export const rawMatchPayloadSchema = z.object({
  ext_rencontre_id: z.string().min(1),
  ext_poule_id: z.string().min(1),
  ext_equipe_dom_id: z.string().min(1),
  ext_equipe_ext_id: z.string().min(1),
  date_heure: z.string().datetime({ offset: true }),

  score_dom: nullableIntFromStringOrNumber.optional(),
  score_ext: nullableIntFromStringOrNumber.optional(),
  score_mt_dom: nullableIntFromStringOrNumber.optional(),
  score_mt_ext: nullableIntFromStringOrNumber.optional(),

  journee: z.coerce.number().int().positive(),
  equipement_id: z.string().optional(),
  fdm_code: z.string().optional(),

  arbitre1_id: z.string().optional(),
  arbitre1_nom: z.string().optional(),
  arbitre2_id: z.string().optional(),
  arbitre2_nom: z.string().optional(),

  source_url: z.string().url(),
});
export type RawMatchPayload = z.infer<typeof rawMatchPayloadSchema>;
