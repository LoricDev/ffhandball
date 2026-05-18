import { z } from "zod";

export const rawClubPayloadSchema = z.object({
  id_ffhb: z.string().regex(/^\d+$/, "id_ffhb must be digits"),
  nom: z.string().min(1),
  ville: z.string().optional(),
  departement_code: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional(),
  source_url: z.string().url(),
});

export type RawClubPayload = z.infer<typeof rawClubPayloadSchema>;
