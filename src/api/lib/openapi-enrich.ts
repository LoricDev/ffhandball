// src/api/lib/openapi-enrich.ts — complète la spec OpenAPI générée avec les réponses d'erreur et en-têtes
// communs à toutes les routes (garantis par les middlewares), pour ne pas les répéter route par route.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const METHODS = ["get", "post", "put", "patch", "delete"];
const errorRef = { content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } };

const rateHeaders: Json = {
  "X-RateLimit-Limit": { description: "Requêtes autorisées par minute", schema: { type: "integer" } },
  "X-RateLimit-Remaining": { description: "Requêtes restantes dans la fenêtre", schema: { type: "integer" } },
  "X-RateLimit-Reset": { description: "Fin de la fenêtre (epoch, secondes)", schema: { type: "integer" } },
  "X-Request-Id": { description: "Identifiant de requête (utile en cas d'erreur)", schema: { type: "string" } },
};

export function enrichOpenApi(doc: Json, opts: { authEnabled: boolean }): Json {
  const paths: Json = doc.paths ?? {};
  for (const [path, item] of Object.entries<Json>(paths)) {
    if (path.startsWith("/admin")) continue;
    for (const m of METHODS) {
      const op = item[m] as Json | undefined;
      if (!op) continue;
      const responses: Json = (op.responses ??= {});
      const hasInput = (op.parameters?.length ?? 0) > 0;
      if (hasInput && !responses["400"]) responses["400"] = { description: "Paramètre invalide", ...errorRef };
      if (opts.authEnabled && !responses["401"] && path !== "/health" && path !== "/ready") {
        responses["401"] = { description: "Clé API absente, invalide ou révoquée", ...errorRef };
      }
      if (!responses["429"]) {
        responses["429"] = {
          description: "Limite de requêtes dépassée (voir l'en-tête Retry-After)",
          headers: { "Retry-After": { description: "Secondes avant la prochaine tentative", schema: { type: "integer" } } },
          ...errorRef,
        };
      }
      if (!responses["500"]) responses["500"] = { description: "Erreur interne (communiquer request_id)", ...errorRef };
      const ok = responses["200"] as Json | undefined;
      if (ok) ok.headers = { ...rateHeaders, ...(ok.headers ?? {}) };
    }
  }
  return doc;
}
