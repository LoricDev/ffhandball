import { z } from "zod";

export const rawSallePayloadSchema = z.object({
  id_ffhb: z.string().min(1), // slug: name_gym + zipcode_gym + city_gym
  nom: z.string().min(1),
  adresse: z.string().optional(),
  code_postal: z.string().regex(/^\d{5}$/).optional(),
  ville: z.string().optional(),
  departement_code: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional(),
  capacite: z.coerce.number().int().positive().optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
  source_url: z.string().url(),
  source_club_id_ffhb: z.string().min(1),
});

export type RawSallePayload = z.infer<typeof rawSallePayloadSchema>;
