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

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const rawMatchPayloadSchema = z.object({
  ext_rencontre_id: z.string().min(1),
  ext_poule_id: z.string().min(1),
  ext_equipe_dom_id: z.string().min(1),
  ext_equipe_ext_id: z.string().min(1),
  // null : date pas encore fixée (seule la journée est connue) ; voir journee_date_debut.
  date_heure: z.string().datetime({ offset: true }).nullable(),
  // Fenêtre de la journée (YYYY-MM-DD), lue dans la liste des journées de la poule.
  journee_date_debut: isoDay.nullable().optional(),
  journee_date_fin: isoDay.nullable().optional(),

  score_dom: nullableIntFromStringOrNumber.optional(),
  score_ext: nullableIntFromStringOrNumber.optional(),
  score_mt_dom: nullableIntFromStringOrNumber.optional(),
  score_mt_ext: nullableIntFromStringOrNumber.optional(),
  // Score affiché « FO » (forfait) pour l'équipe concernée : la conversion en entier le perd (→ null).
  forfait_dom: z.boolean().optional(),
  forfait_ext: z.boolean().optional(),

  journee: z.coerce.number().int().positive(),
  equipement_id: z.string().optional(),
  fdm_code: z.string().optional(),

  arbitre1_id: z.string().optional(),
  arbitre1_nom: z.string().optional(),
  arbitre2_id: z.string().optional(),
  arbitre2_nom: z.string().optional(),

  source_url: z.string().url(),
}).refine((m) => m.date_heure !== null || !!m.journee_date_debut, {
  message: "date_heure absente et journée sans date de début : match non datable",
  path: ["date_heure"],
});
export type RawMatchPayload = z.infer<typeof rawMatchPayloadSchema>;
