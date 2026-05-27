// src/schemas/phase.schema.ts
import { z } from "zod";

export const rawPhasePayloadSchema = z.object({
  ext_phase_id: z.string().min(1),
  ext_competition_id: z.string().min(1),
  nom: z.string().min(1),
  source_url: z.string().url(),
});

export type RawPhasePayload = z.infer<typeof rawPhasePayloadSchema>;
