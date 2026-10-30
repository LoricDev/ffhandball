// src/api/middleware/http-cache.ts — ETag + Cache-Control sur les GET de données.
//
// Les données ne changent que quelques fois par jour (crons) : un client ou un CDN peut réutiliser
// une réponse 60 s, et revalider ensuite avec If-None-Match (→ 304 sans corps, donc sans transfert).
// L'ETag est calculé par hono sur le corps de la réponse. L'accès à la base reste nécessaire pour
// calculer l'ETag ; le gain est sur la bande passante et sur les clients qui respectent max-age.
import type { MiddlewareHandler } from "hono";
import { etag } from "hono/etag";

/** Jamais mis en cache : sondes, admin, statut (déjà frais par construction). */
function isUncached(path: string): boolean {
  return (
    path === "/health" ||
    path === "/ready" ||
    path === "/admin" ||
    path.startsWith("/admin/") ||
    path === "/status" ||
    path === "/statut"
  );
}

/** Référentiels quasi statiques et spec (change au déploiement) : cache plus long que les données de matchs. */
function maxAgeFor(path: string, dflt: number): number {
  if (path === "/v1/saisons" || path === "/v1/departements" || path === "/v1/ligues") return 3600;
  if (path === "/openapi.json") return 300;
  return dflt;
}

export interface HttpCacheOptions {
  /** Avec auth par clé, la réponse peut dépendre de la clé : cache privé + Vary: Authorization. */
  authEnabled: boolean;
  maxAgeSeconds?: number;
  staleWhileRevalidateSeconds?: number;
}

export function httpCacheMiddleware(opts: HttpCacheOptions): MiddlewareHandler {
  const maxAge = opts.maxAgeSeconds ?? 60;
  const swr = opts.staleWhileRevalidateSeconds ?? 300;
  const withEtag = etag({ weak: true });

  return async (c, next) => {
    if (c.req.method !== "GET" || isUncached(c.req.path)) return next();

    await withEtag(c, async () => {
      await next();
      if (c.res.status !== 200) return;
      const age = maxAgeFor(c.req.path, maxAge);
      c.res.headers.set(
        "Cache-Control",
        `${opts.authEnabled ? "private" : "public"}, max-age=${age}, stale-while-revalidate=${swr}`,
      );
      if (opts.authEnabled) c.res.headers.append("Vary", "Authorization");
    });
  };
}
