// src/api/routes/admin.ts
// Endpoints d'administration des clés API. Protégés par X-Admin-Secret (PAS par clé API).
// Volontairement hors OpenAPI public (Hono brut) pour ne pas exposer la surface admin.
import { Hono } from "hono";
import { createApiKey, renewApiKey, revokeApiKey, listApiKeys } from "@/api/lib/repositories/api-keys.repo.js";

const admin = new Hono();

// Garde : ADMIN_SECRET configuré + header X-Admin-Secret correspondant.
// Lecture runtime de process.env.ADMIN_SECRET (validé au démarrage via env schema).
admin.use("/admin/*", async (c, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return c.json(
      { error: { code: "SERVICE_UNAVAILABLE" as const, message: "Admin désactivé (ADMIN_SECRET non configuré)" } },
      503,
    );
  }
  if (c.req.header("x-admin-secret") !== secret) {
    return c.json({ error: { code: "UNAUTHORIZED" as const, message: "Secret admin invalide" } }, 401);
  }
  await next();
});

admin.get("/admin/api-keys", async (c) => {
  return c.json({ data: await listApiKeys() });
});

admin.post("/admin/api-keys", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const created = await createApiKey({
    label: typeof body.label === "string" ? body.label : undefined,
    months: typeof body.months === "number" ? body.months : undefined,
    rate_limit_per_min: typeof body.rate_limit_per_min === "number" ? body.rate_limit_per_min : undefined,
    noExpiry: body.noExpiry === true,
  });
  return c.json({ data: created }, 201);
});

admin.post("/admin/api-keys/:key_prefix/renew", async (c) => {
  const prefix = c.req.param("key_prefix");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const months = typeof body.months === "number" ? body.months : 1;
  const res = await renewApiKey(prefix, months);
  if (!res) return c.json({ error: { code: "NOT_FOUND" as const, message: "Clé introuvable" } }, 404);
  return c.json({ data: { key_prefix: prefix, valid_until: res.valid_until } });
});

admin.post("/admin/api-keys/:key_prefix/revoke", async (c) => {
  const prefix = c.req.param("key_prefix");
  const ok = await revokeApiKey(prefix);
  if (!ok) return c.json({ error: { code: "NOT_FOUND" as const, message: "Clé introuvable" } }, 404);
  return c.json({ data: { key_prefix: prefix, active: false } });
});

export default admin;
