// src/api/middleware/request-id.ts — identifiant de requête (X-Request-Id), repris des erreurs 500
// pour retrouver la trace dans les logs sans exposer de détail interne au client.
import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    // On n'accepte qu'un identifiant court et sobre (évite l'injection de log/en-tête).
    const id = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    await next();
  };
}
