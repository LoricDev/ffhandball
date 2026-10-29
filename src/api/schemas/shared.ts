// src/api/schemas/shared.ts — briques de schéma réutilisées par tous les endpoints (définies une seule fois).
import { z } from "@hono/zod-openapi";
import { toDayString, toIsoString } from "@/api/lib/dates.js";

/** Date-heure en sortie : toujours ISO 8601 (le driver pg renvoie des Date pour les timestamptz). */
export const dateTimeOut = z
  .union([z.string(), z.date()])
  .transform(toIsoString)
  .openapi({ type: "string", format: "date-time", example: "2026-09-03T20:00:00.000Z" });

export const dateOut = z
  .union([z.string(), z.date()])
  .transform(toDayString)
  .openapi({ type: "string", format: "date", example: "2026-09-03" });

/** Référence minimale à une équipe. */
export const equipeRefSchema = z.object({ id_ffhb: z.string(), nom: z.string() }).openapi("EquipeRef");

/** Référence à un club (code_ffhb = code à 7 chiffres, préfixe des licences). */
export const clubRefSchema = z
  .object({ id_ffhb: z.string(), code_ffhb: z.string().nullable(), nom: z.string() })
  .openapi("ClubRef");

/** Référence à une compétition. */
export const competitionRefSchema = z
  .object({ id_ffhb: z.string(), nom: z.string(), niveau: z.string().nullable() })
  .openapi("CompetitionRef");

/** Référence à une phase. */
export const phaseRefSchema = z.object({ id_ffhb: z.string(), nom: z.string() }).openapi("PhaseRef");
