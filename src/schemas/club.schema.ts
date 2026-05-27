import { z } from "zod";

export const rawClubPayloadSchema = z.object({
  id_ffhb: z.string().regex(/^\d+$/, "id_ffhb must be digits"),
  nom: z.string().min(1),
  ville: z.string().optional(),
  departement_code: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional(),
  source_url: z.string().url(),

  // Detail page enrichments (from monclub.ffhandball.fr fiche détail)
  slug: z.string().min(1).optional(),
  telephone: z.string().optional(),
  email: z.string().email().optional(),
  site_web: z.string().url().optional(),
  adresse_correspondance: z.string().optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
  register_link: z.string().url().optional(),
  logo_club: z.string().optional(),
  salle_principale_id_ffhb: z.string().optional(),

  // License counts (from acf.nb_licence_*_club — source values are strings, coerce to int)
  nb_licence_senior_h: z.coerce.number().int().nonnegative().optional(),
  nb_licence_senior_f: z.coerce.number().int().nonnegative().optional(),
  nb_licence_jeunes_h: z.coerce.number().int().nonnegative().optional(),
  nb_licence_jeunes_f: z.coerce.number().int().nonnegative().optional(),
});

export type RawClubPayload = z.infer<typeof rawClubPayloadSchema>;
