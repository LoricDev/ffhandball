// src/api/routes/health.ts
import { newRouter } from "@/api/lib/router.js";
import { createRoute, z } from "@hono/zod-openapi";
import { query } from "@/db/client.js";

const health = newRouter();

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Sonde de vie (le process répond)",
  tags: ["health"],
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
      description: "Le service répond",
    },
  },
});

health.openapi(healthRoute, (c) => c.json({ status: "ok" as const }));

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  summary: "Sonde de disponibilité (la base répond)",
  tags: ["health"],
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ status: z.literal("ready"), db: z.literal("connected") }) } },
      description: "Service prêt (base connectée)",
    },
    503: {
      content: { "application/json": { schema: z.object({ status: z.literal("not-ready"), db: z.string() }) } },
      description: "Service non prêt (base indisponible)",
    },
  },
});

health.openapi(readyRoute, async (c) => {
  try {
    await query("SELECT 1");
    return c.json({ status: "ready" as const, db: "connected" as const }, 200);
  } catch (err) {
    return c.json({ status: "not-ready" as const, db: String(err instanceof Error ? err.message : err) }, 503);
  }
});

export default health;
