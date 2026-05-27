import { z } from "zod";

export const rawEngagementPayloadSchema = z.object({
  ext_equipe_id: z.string().min(1),
  ext_poule_id: z.string().min(1),
  source_url: z.string().url(),
});
export type RawEngagementPayload = z.infer<typeof rawEngagementPayloadSchema>;
