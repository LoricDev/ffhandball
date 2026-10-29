// src/api/schemas/referentiel.api.ts
import { z } from "@hono/zod-openapi";
import { dateOut } from "@/api/schemas/shared.js";

export const saisonItemSchema = z
  .object({
    saison_code: z.string().openapi({ example: "2025-2026" }),
    date_debut: dateOut.nullable(),
    date_fin: dateOut.nullable(),
  })
  .openapi("SaisonItem");

export const referentielItemSchema = z
  .object({
    code: z.string().openapi({ example: "75" }),
    nom: z.string().nullable(),
  })
  .openapi("ReferentielItem");
