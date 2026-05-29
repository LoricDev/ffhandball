// src/api/server.ts
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { serve } from "@hono/node-server";
import healthRoutes from "@/api/routes/health.js";
import clubsRoutes from "@/api/routes/clubs.js";
import matchsRoutes from "@/api/routes/matchs.js";
import classementsRoutes from "@/api/routes/classements.js";
import joueursRoutes from "@/api/routes/joueurs.js";
import searchRoutes from "@/api/routes/search.js";
import competitionsRoutes from "@/api/routes/competitions.js";
import poulesRoutes from "@/api/routes/poules.js";
import equipesRoutes from "@/api/routes/equipes.js";
import statsJoueursRoutes from "@/api/routes/stats-joueurs.js";
import arbitresRoutes from "@/api/routes/arbitres.js";
import sallesRoutes from "@/api/routes/salles.js";
import referentielsRoutes from "@/api/routes/referentiels.js";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { requestLoggerMiddleware } from "@/api/middleware/request-logger.js";
import { errorHandlerMiddleware } from "@/api/middleware/error-handler.js";
import { rateLimitMiddleware } from "@/api/middleware/rate-limit.js";

export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "BAD_REQUEST" as const,
              message: "Validation error",
              details: result.error.flatten(),
            },
          },
          400,
        );
      }
    },
  });

  // Middlewares (ordre important)
  app.use("*", requestLoggerMiddleware());
  app.use("*", errorHandlerMiddleware());
  app.use("*", rateLimitMiddleware());

  app.route("/", healthRoutes);
  app.route("/", clubsRoutes);
  app.route("/", matchsRoutes);
  app.route("/", classementsRoutes);
  app.route("/", joueursRoutes);
  app.route("/", searchRoutes);
  app.route("/", competitionsRoutes);
  app.route("/", poulesRoutes);
  app.route("/", equipesRoutes);
  app.route("/", statsJoueursRoutes);
  app.route("/", arbitresRoutes);
  app.route("/", sallesRoutes);
  app.route("/", referentielsRoutes);

  // OpenAPI spec + Swagger UI
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      version: "1.0.0",
      title: "ffhandball API",
      description:
        "API publique read-only sur les données handball français scrapées de FFHandball",
    },
  });

  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp();
  const port = env.API_PORT;
  const host = env.API_HOST;
  logger.info({ port, host }, "API server starting");
  serve({ fetch: app.fetch, port, hostname: host });
}
