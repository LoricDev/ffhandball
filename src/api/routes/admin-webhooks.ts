// src/api/routes/admin-webhooks.ts — gestion des webhooks de résultats (voir docs/webhooks.md).
// Monté par admin.ts APRÈS le garde X-Admin-Secret : ces routes sont donc protégées.
import { Hono } from "hono";
import { z } from "zod";
import { assertPublicHttpsUrl, UnsafeUrlError } from "@/webhooks/url-guard.js";
import {
  createWebhook,
  listWebhooks,
  setWebhookActive,
  deleteWebhook,
  listDeliveries,
  enqueuePing,
} from "@/api/lib/repositories/webhooks.repo.js";

const webhooks = new Hono();

const createSchema = z.object({
  url: z.string().url().max(2000),
  label: z.string().max(200).optional(),
  club_id_ffhb: z.string().max(50).optional(),
});

const notFound = { error: { code: "NOT_FOUND" as const, message: "Abonnement introuvable" } };

webhooks.get("/admin/webhooks", async (c) => c.json({ data: await listWebhooks() }));

webhooks.post("/admin/webhooks", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: { code: "BAD_REQUEST" as const, message: "Corps invalide", details: parsed.error.flatten() } },
      400,
    );
  }
  let url: string;
  try {
    url = await assertPublicHttpsUrl(parsed.data.url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return c.json({ error: { code: "BAD_REQUEST" as const, message: `URL refusée : ${err.message}` } }, 400);
    }
    throw err;
  }
  const created = await createWebhook({ ...parsed.data, url });
  // Le secret n'est affiché qu'ici : à conserver par l'abonné pour vérifier les signatures.
  return c.json({ data: created }, 201);
});

webhooks.post("/admin/webhooks/:id/disable", async (c) => {
  const ok = await setWebhookActive(c.req.param("id"), false);
  return ok ? c.json({ data: { active: false } }) : c.json(notFound, 404);
});

webhooks.post("/admin/webhooks/:id/enable", async (c) => {
  const ok = await setWebhookActive(c.req.param("id"), true);
  return ok ? c.json({ data: { active: true } }) : c.json(notFound, 404);
});

webhooks.post("/admin/webhooks/:id/test", async (c) => {
  const ok = await enqueuePing(c.req.param("id"));
  return ok
    ? c.json({ data: { queued: true, note: "livré au prochain passage du worker (1 min max)" } }, 202)
    : c.json(notFound, 404);
});

webhooks.get("/admin/webhooks/:id/deliveries", async (c) => c.json({ data: await listDeliveries(c.req.param("id")) }));

webhooks.delete("/admin/webhooks/:id", async (c) => {
  const ok = await deleteWebhook(c.req.param("id"));
  return ok ? c.json({ data: { deleted: true } }) : c.json(notFound, 404);
});

export default webhooks;
