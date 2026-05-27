import { z } from "zod";

export const rawEquipePayloadSchema = z.object({
  ext_equipe_id: z.string().min(1),
  nom: z.string().min(1),
  ext_structure_id: z.string().optional(),
  logo: z.string().optional(),
  source_url: z.string().url(),
});
export type RawEquipePayload = z.infer<typeof rawEquipePayloadSchema>;
