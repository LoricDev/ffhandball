// src/api/middleware/error-handler.ts
import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "@/lib/logger.js";

function requestIdOf(c: Context): string | undefined {
  return c.get("requestId") as string | undefined;
}

/** Réponse 500 générique : le détail (message SQL, pile…) reste dans les logs, jamais dans la réponse. */
function internalError(c: Context, err: unknown): Response {
  const request_id = requestIdOf(c);
  logger.error(
    { err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err), url: c.req.url, method: c.req.method, request_id },
    "API unhandled error",
  );
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR" as const,
        message: "Erreur interne du serveur",
        ...(request_id ? { request_id } : {}),
      },
    },
    500,
  );
}

/** Erreurs levées par un handler : Hono les route vers app.onError, jamais vers un try/catch de middleware. */
export const apiErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    const code = err.status === 401 ? "UNAUTHORIZED" : err.status === 404 ? "NOT_FOUND" : err.status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
    if (err.status >= 500) return internalError(c, err);
    return c.json({ error: { code, message: err.message || "Requête invalide" } }, err.status);
  }
  return internalError(c, err);
};

export const apiNotFoundHandler: NotFoundHandler = (c) =>
  c.json({ error: { code: "NOT_FOUND" as const, message: `Route ${c.req.method} ${c.req.path} introuvable. Voir /docs.` } }, 404);

/** Filet de sécurité pour les erreurs levées par un autre middleware. */
export function errorHandlerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      return apiErrorHandler(err as Error, c);
    }
  };
}
