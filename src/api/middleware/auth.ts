// src/api/middleware/auth.ts
import type { MiddlewareHandler } from "hono";
import { findActiveKeyByToken } from "@/api/lib/repositories/api-keys.repo.js";

/** Chemins accessibles sans clé API. `/admin` a son propre garde (X-Admin-Secret). */
const PUBLIC_EXACT = new Set(["/health", "/ready", "/openapi.json"]);
function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT.has(path)) return true;
  if (path === "/docs" || path.startsWith("/docs/")) return true;
  if (path === "/admin" || path.startsWith("/admin/")) return true;
  return false;
}

function extractToken(authHeader: string | undefined, apiKeyHeader: string | undefined): string | null {
  if (authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m) return m[1]!.trim();
  }
  if (apiKeyHeader && apiKeyHeader.trim().length > 0) return apiKeyHeader.trim();
  return null;
}

/**
 * Auth par clé API. Monté seulement si `API_AUTH_ENABLED`.
 * Laisse passer les chemins publics ; exige sinon `Authorization: Bearer <token>`
 * (ou `X-API-Key`). Attache la clé au contexte (`c.set("apiKey", ...)`) pour le rate-limit.
 */
export function apiKeyAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (isPublicPath(c.req.path)) return next();

    const token = extractToken(c.req.header("authorization"), c.req.header("x-api-key"));
    if (!token) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json(
        { error: { code: "UNAUTHORIZED" as const, message: "Clé API requise (header Authorization: Bearer <token>)" } },
        401,
      );
    }

    const key = await findActiveKeyByToken(token);
    if (!key) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json(
        { error: { code: "UNAUTHORIZED" as const, message: "Clé API invalide, révoquée ou expirée" } },
        401,
      );
    }

    c.set("apiKey", key);
    await next();
  };
}
