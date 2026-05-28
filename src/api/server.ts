// src/api/server.ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { serve } from "@hono/node-server";
import healthRoutes from "@/api/routes/health.js";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";

export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  app.route("/", healthRoutes);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp();
  const port = env.API_PORT;
  const host = env.API_HOST;
  logger.info({ port, host }, "API server starting");
  serve({ fetch: app.fetch, port, hostname: host });
}
