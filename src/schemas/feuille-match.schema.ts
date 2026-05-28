// src/schemas/feuille-match.schema.ts
import { z } from "zod";

const intOrNull = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  },
  z.number().int().nullable(),
);

export const rawJoueurInFdmSchema = z.object({
  numero_licence: z.string().regex(/^\d{10,13}$/),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  type_licence: z.string().length(1),
  numero_maillot: intOrNull,
  capitaine: z.boolean(),
  gardien: z.boolean(),
  buts: intOrNull,
  sept_metres_reussis: intOrNull,
  sept_metres_tentes: intOrNull,
  tirs: intOrNull,
  arrets: intOrNull,
  avertissement: z.boolean(),
  exclusions_2min: intOrNull,
  disqualifie: z.boolean(),
});
export type RawJoueurInFdm = z.infer<typeof rawJoueurInFdmSchema>;

export const rawOfficielInFdmSchema = z.object({
  role: z.string().min(1),
  cote: z.enum(["recevant", "visiteur", "neutre"]),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  numero_licence: z.string().regex(/^\d{10,13}$/).optional(),
});
export type RawOfficielInFdm = z.infer<typeof rawOfficielInFdmSchema>;

export const rawActionInFdmSchema = z.object({
  ordre: z.number().int().nonnegative(),
  periode: z.number().int().min(1).max(4),
  temps_seconds: z.number().int().nonnegative(),
  score_recevant: z.number().int().nonnegative(),
  score_visiteur: z.number().int().nonnegative(),
  type_action: z.enum([
    "but", "tir", "arret", "avertissement",
    "exclusion_2min", "disqualification",
    "temps_mort_recevant", "temps_mort_visiteur",
    "protocole_commotion", "autre",
  ]),
  cote: z.enum(["recevant", "visiteur"]).optional(),
  numero_maillot: z.number().int().nullable().optional(),
  numero_licence: z.string().optional(),
  acteur_role: z.enum(["joueur", "officiel"]).optional(),
  description_brute: z.string(),
});
export type RawActionInFdm = z.infer<typeof rawActionInFdmSchema>;

export const rawFeuilleMatchPayloadSchema = z.object({
  fdm_code: z.string().min(1),
  organisateur: z.string().optional(),
  organisateur_code: z.string().optional(),
  competition_libelle: z.string().optional(),
  groupe: z.string().optional(),
  poule_libelle: z.string().optional(),
  equipe_recevant_libelle: z.string().min(1),
  equipe_visiteur_libelle: z.string().min(1),
  equipe_recevant_code: z.string().optional(),
  equipe_visiteur_code: z.string().optional(),
  date_heure_str: z.string().min(1),
  journee_libelle: z.string().optional(),
  salle_libelle: z.string().optional(),
  salle_adresse: z.string().optional(),
  score_recevant: intOrNull,
  score_visiteur: intOrNull,
  score_mi_temps_recevant: intOrNull,
  score_mi_temps_visiteur: intOrNull,
  statut_match: z.string().optional(),
  officiels: z.array(rawOfficielInFdmSchema),
  composition_recevant: z.array(rawJoueurInFdmSchema),
  composition_visiteur: z.array(rawJoueurInFdmSchema),
  actions: z.array(rawActionInFdmSchema),
  source_url: z.string().url(),
  pdf_size_bytes: z.number().int().positive().optional(),
});
export type RawFeuilleMatchPayload = z.infer<typeof rawFeuilleMatchPayloadSchema>;
