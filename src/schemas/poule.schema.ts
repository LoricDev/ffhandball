// src/schemas/poule.schema.ts
import { z } from "zod";

export const rawPoulePayloadSchema = z.object({
  ext_poule_id: z.string().min(1),
  ext_phase_id: z.string().min(1),
  nom: z.string().min(1),
  source_url: z.string().url(),
});

export type RawPoulePayload = z.infer<typeof rawPoulePayloadSchema>;
