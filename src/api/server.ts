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
import adminRoutes from "@/api/routes/admin.js";
import statusRoutes from "@/api/routes/status.js";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { requestLoggerMiddleware } from "@/api/middleware/request-logger.js";
import { requestIdMiddleware } from "@/api/middleware/request-id.js";
import { enrichOpenApi } from "@/api/lib/openapi-enrich.js";
import { errorHandlerMiddleware, apiErrorHandler, apiNotFoundHandler } from "@/api/middleware/error-handler.js";
import { rateLimitMiddleware } from "@/api/middleware/rate-limit.js";
import { apiKeyAuthMiddleware } from "@/api/middleware/auth.js";
import { httpCacheMiddleware } from "@/api/middleware/http-cache.js";

export interface BuildAppOptions {
  /** Active l'auth par clé API. Défaut : env.API_AUTH_ENABLED. */
  authEnabled?: boolean;
}

export function buildApp(opts: BuildAppOptions = {}): OpenAPIHono {
  const authEnabled = opts.authEnabled ?? env.API_AUTH_ENABLED;
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

  app.onError(apiErrorHandler);
  app.notFound(apiNotFoundHandler);

  // Middlewares (ordre important : auth avant rate-limit pour la limite par clé)
  app.use("*", requestIdMiddleware());
  app.use("*", requestLoggerMiddleware());
  app.use("*", errorHandlerMiddleware());
  if (authEnabled) app.use("*", apiKeyAuthMiddleware());
  app.use("*", rateLimitMiddleware());
  app.use("*", httpCacheMiddleware({ authEnabled }));

  // La racine renvoyait un 404 aux visiteurs et aux scanners : on les oriente vers la documentation.
  app.get("/", (c) => c.redirect("/docs", 302));

  app.route("/", adminRoutes);
  app.route("/", healthRoutes);
  app.route("/", statusRoutes);
  // Routes de données versionnées : /v1/...
  const dataRoutes = [
    clubsRoutes,
    matchsRoutes,
    classementsRoutes,
    joueursRoutes,
    searchRoutes,
    competitionsRoutes,
    poulesRoutes,
    equipesRoutes,
    statsJoueursRoutes,
    arbitresRoutes,
    sallesRoutes,
    referentielsRoutes,
  ];
  for (const r of dataRoutes) app.route("/v1", r);

  // OpenAPI spec + Swagger UI
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Clé API : Authorization: Bearer <token>. Requise si l'auth est activée.",
  });
  const openApiConfig = {
    openapi: "3.1.0" as const,
    info: {
      version: "1.4.0",
      title: "ffhandball API",
      description:
        "API read-only sur les données handball français scrapées de FFHandball.\n\n" +
        "**Conventions** : réponses `{ data, meta }` ; listes paginées par `limit` (≤ 100) / `offset` avec `meta.total` ; " +
        "erreurs `{ error: { code, message } }` ; dates-heures en ISO 8601, jours en `YYYY-MM-DD` ; " +
        "`groupes` = équipes réelles d'un club (clé `groupe_cle`, filtre `?groupe=`) ; en-têtes `ETag` (revalidation `If-None-Match` → 304), " +
        "`X-RateLimit-*` et `X-Request-Id`." +
        (authEnabled ? " Authentification par clé API requise (Authorization: Bearer)." : ""),
    },
    ...(authEnabled ? { security: [{ bearerAuth: [] }] } : {}),
  };
  // Spec servie à la main (et non via app.doc31) pour y ajouter les erreurs/en-têtes communs.
  app.get("/openapi.json", (c) =>
    c.json(enrichOpenApi(app.getOpenAPI31Document(openApiConfig) as never, { authEnabled })),
  );

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
