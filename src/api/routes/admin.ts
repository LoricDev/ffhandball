// src/api/routes/admin.ts
// Endpoints d'administration des clés API. Protégés par X-Admin-Secret (PAS par clé API).
// Volontairement hors OpenAPI public (Hono brut) pour ne pas exposer la surface admin.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { createApiKey, renewApiKey, revokeApiKey, listApiKeys } from "@/api/lib/repositories/api-keys.repo.js";
import adminWebhooks from "@/api/routes/admin-webhooks.js";
import adminEquipes from "@/api/routes/admin-equipes.js";
import { getTraffic } from "@/api/lib/repositories/traffic.repo.js";
import { getPipelineSnapshot } from "@/api/lib/repositories/pipeline-status.repo.js";

const admin = new Hono();

// Comparaison à temps constant (hash des deux côtés : longueurs égales, pas de fuite par timing).
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Page du tableau de bord : HTML statique SANS donnée (le secret est saisi dans la page et n'est
// envoyé qu'à /admin/pipeline). Déclarée avant le garde, qui ne s'applique qu'aux routes suivantes.
const DASHBOARD_HTML = readFileSync(new URL("../admin/dashboard.html", import.meta.url), "utf8");
admin.get("/admin/dashboard", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(DASHBOARD_HTML);
});

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
  if (!safeEqual(c.req.header("x-admin-secret") ?? "", secret)) {
    return c.json({ error: { code: "UNAUTHORIZED" as const, message: "Secret admin invalide" } }, 401);
  }
  await next();
});

admin.get("/admin/pipeline", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ data: await getPipelineSnapshot() });
});

admin.get("/admin/api-keys", async (c) => {
  return c.json({ data: await listApiKeys() });
});

admin.get("/admin/traffic", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ data: await getTraffic(Number(c.req.query("hours") ?? 24)) });
});

const createKeySchema = z.object({
  label: z.string().max(200).optional(),
  months: z.number().int().min(1).max(120).optional(),
  rate_limit_per_min: z.number().int().min(1).max(100_000).optional(),
  noExpiry: z.boolean().optional(),
});
const renewKeySchema = z.object({ months: z.number().int().min(1).max(120).optional() });

const badBody = (c: Context, err: z.ZodError) =>
  c.json({ error: { code: "BAD_REQUEST" as const, message: "Corps invalide", details: err.flatten() } }, 400);

admin.post("/admin/api-keys", async (c) => {
  const parsed = createKeySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return badBody(c, parsed.error);
  const created = await createApiKey(parsed.data);
  return c.json({ data: created }, 201);
});

admin.post("/admin/api-keys/:key_prefix/renew", async (c) => {
  const prefix = c.req.param("key_prefix");
  const parsed = renewKeySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return badBody(c, parsed.error);
  const months = parsed.data.months ?? 1;
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

// Webhooks de résultats : monté après le garde ci-dessus, donc protégé par X-Admin-Secret.
admin.route("/", adminWebhooks);
admin.route("/", adminEquipes);

export default admin;
