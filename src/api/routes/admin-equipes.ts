// src/api/routes/admin-equipes.ts — corrections manuelles du regroupement des équipes d'un club.
// Monté par admin.ts APRÈS le garde X-Admin-Secret : ces routes sont donc protégées.
import { Hono } from "hono";
import { z } from "zod";
import { currentSaison } from "@/lib/saison.js";
import { getClubByIdFfhb } from "@/api/lib/repositories/club.repo.js";
import { listClubEquipesAvecPartenaires } from "@/api/lib/repositories/equipe.repo.js";
import { deleteOverride, getOverrides, listOverrides, upsertOverride } from "@/api/lib/repositories/equipe-overrides.repo.js";
import { grouperEquipes } from "@/api/lib/equipe-groupes.js";

const equipes = new Hono();

const overrideSchema = z.object({
  categorie: z.enum(["Seniors", "-20", "-19", "-18", "-17", "-15", "-13", "-11", "-9", "-7", "Loisir", "Autre"]).nullish(),
  sexe: z.enum(["M", "F", "mixte"]).nullish(),
  rang: z.number().int().min(1).max(9).nullish(),
  entente: z.boolean().nullish(),
  exclu: z.boolean().optional(),
  note: z.string().max(500).nullish(),
});

const notFound = (message: string) => ({ error: { code: "NOT_FOUND" as const, message } });

/** Groupes d'un club tels que l'API les sert (corrections appliquées) + toutes les inscriptions et corrections. */
equipes.get("/admin/clubs/:id/groupes", async (c) => {
  const club = await getClubByIdFfhb(c.req.param("id"));
  if (!club) return c.json(notFound("Club introuvable"), 404);
  const saison = c.req.query("saison") ?? currentSaison();
  const inscriptions = await listClubEquipesAvecPartenaires(club, saison, { include_ententes: true, min_confidence: "basse" });
  const overrides = await getOverrides(inscriptions.map((e) => e.id_ffhb));
  return c.json({
    data: {
      club: { id_ffhb: club.id_ffhb, nom: club.nom },
      saison,
      groupes: grouperEquipes(inscriptions, overrides),
      inscriptions,
      overrides: [...overrides.values()],
    },
  });
});

equipes.get("/admin/equipe-overrides", async (c) => c.json({ data: await listOverrides() }));

equipes.put("/admin/equipe-overrides/:id", async (c) => {
  const parsed = overrideSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: { code: "BAD_REQUEST" as const, message: "Corps invalide", details: parsed.error.flatten() } }, 400);
  }
  const row = await upsertOverride(c.req.param("id"), parsed.data);
  if (!row) return c.json(notFound("Inscription introuvable"), 404);
  return c.json({ data: row });
});

equipes.delete("/admin/equipe-overrides/:id", async (c) => {
  if (!(await deleteOverride(c.req.param("id")))) return c.json(notFound("Aucune correction pour cette inscription"), 404);
  return c.json({ data: { equipe_id_ffhb: c.req.param("id"), deleted: true } });
});

export default equipes;
