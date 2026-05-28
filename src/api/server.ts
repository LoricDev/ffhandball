// src/api/server.ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { serve } from "@hono/node-server";
import healthRoutes from "@/api/routes/health.js";
import clubsRoutes from "@/api/routes/clubs.js";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { requestLoggerMiddleware } from "@/api/middleware/request-logger.js";
import { errorHandlerMiddleware } from "@/api/middleware/error-handler.js";
import { rateLimitMiddleware } from "@/api/middleware/rate-limit.js";

export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  // Middlewares (ordre important)
  app.use("*", requestLoggerMiddleware());
  app.use("*", errorHandlerMiddleware());
  app.use("*", rateLimitMiddleware());

  app.route("/", healthRoutes);
  app.route("/", clubsRoutes);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp();
  const port = env.API_PORT;
  const host = env.API_HOST;
  logger.info({ port, host }, "API server starting");
  serve({ fetch: app.fetch, port, hostname: host });
}
