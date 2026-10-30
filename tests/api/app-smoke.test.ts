import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { closePool } from "@/db/client.js";

afterAll(async () => {
  await closePool();
});

// Garde-fou : l'app doit se construire (pas de route dupliquée, schémas OpenAPI valides)
// et exposer sa spec. Une erreur de merge ici fait échouer la CI avant la prod.
describe("app smoke", () => {
  const app = buildApp({ authEnabled: false });

  it("construit la spec OpenAPI avec les routes principales", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    for (const p of ["/v1/clubs", "/v1/matchs", "/v1/classements", "/health"]) {
      expect(Object.keys(spec.paths)).toContain(p);
    }
    // Les alias sans préfixe restent servis mais ne polluent pas la spec.
    expect(Object.keys(spec.paths)).not.toContain("/clubs");
  });

  it("répond sur /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("racine", () => {
  const app = buildApp({ authEnabled: true });

  it("redirige / vers /docs, même quand l'authentification par clé est active", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/docs");
  });
});
