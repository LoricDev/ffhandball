// src/api/schemas/referentiel.api.ts
import { z } from "@hono/zod-openapi";

const dateOut = z
  .union([z.string(), z.date()])
  .nullable()
  .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v));

export const saisonItemSchema = z
  .object({
    saison_code: z.string().openapi({ example: "2025-2026" }),
    date_debut: dateOut,
    date_fin: dateOut,
  })
  .openapi("SaisonItem");

export const referentielItemSchema = z
  .object({
    code: z.string().openapi({ example: "75" }),
    nom: z.string().nullable(),
  })
  .openapi("ReferentielItem");
