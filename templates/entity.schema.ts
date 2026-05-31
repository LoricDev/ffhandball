// templates/entity.schema.ts
// ─────────────────────────────────────────────────────────────────────────────
// MODÈLE de schéma Zod pour le PAYLOAD BRUT d'une entité.
// Copier vers : src/schemas/<entity>.schema.ts
// Remplacer partout : Entity → NomEntité (PascalCase), entity → nom-entité (kebab).
//
// Rôle : décrit la forme de l'objet produit par le scraper et stocké dans raw.*.
//        Sert aussi de garde de validation à l'ETL (on rejette ce qui ne valide pas).
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";

export const rawEntityPayloadSchema = z.object({
  // Clé naturelle stable côté source (ffhandball) — sert de natural_key en raw.
  ext_entity_id: z.string().min(1),

  // Champs métier. Mettre .optional() pour tout ce qui peut manquer côté source.
  nom: z.string().min(1),
  // exemple_nombre: z.coerce.number().int().optional(),
  // exemple_date:   z.string().optional(), // parsé plus tard côté ETL

  // TOUJOURS conserver l'URL d'origine (traçabilité).
  source_url: z.string().url(),
});

export type RawEntityPayload = z.infer<typeof rawEntityPayloadSchema>;
