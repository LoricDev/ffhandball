import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

describe("http-cache middleware", () => {
  beforeEach(() => _resetBuckets());

  it("ajoute ETag + Cache-Control public sur un GET de données (auth off)", async () => {
    const app = buildApp({ authEnabled: false });
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^W\//);
    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("répond 304 sans corps quand If-None-Match correspond", async () => {
    const app = buildApp({ authEnabled: false });
    const first = await app.request("/openapi.json");
    const etagValue = first.headers.get("ETag")!;
    const second = await app.request("/openapi.json", { headers: { "If-None-Match": etagValue } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("cache privé + Vary: Authorization quand l'auth par clé est active", async () => {
    const app = buildApp({ authEnabled: true });
    const res = await app.request("/openapi.json"); // chemin public
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Vary") ?? "").toContain("Authorization");
  });

  it("ne met pas en cache /health", async () => {
    const app = buildApp({ authEnabled: false });
    const res = await app.request("/health");
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(res.headers.get("ETag")).toBeNull();
  });
});
