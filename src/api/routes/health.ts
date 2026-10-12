// src/api/routes/health.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { query } from "@/db/client.js";

const health = new OpenAPIHono();

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["health"],
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
      description: "Service is alive",
    },
  },
});

health.openapi(healthRoute, (c) => c.json({ status: "ok" as const }));

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  tags: ["health"],
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ status: z.literal("ready"), db: z.literal("connected") }) } },
      description: "Service is ready (DB connected)",
    },
    503: {
      content: { "application/json": { schema: z.object({ status: z.literal("not-ready"), db: z.string() }) } },
      description: "Service is not ready (DB issue)",
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
