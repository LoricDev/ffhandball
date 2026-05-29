// tests/api/middleware/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { createApiKey } from "@/api/lib/repositories/api-keys.repo.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

// App avec auth activée (indépendant de l'env)
const app = buildApp({ authEnabled: true });

let validToken: string;
let expiredToken: string;

beforeAll(async () => {
  await query(`DELETE FROM core.api_keys WHERE label LIKE 'TEST-AUTH-%'`);
  const ok = await createApiKey({ label: "TEST-AUTH-OK", months: 1 });
  validToken = ok.token;
  const exp = await createApiKey({ label: "TEST-AUTH-EXP", months: 1 });
  expiredToken = exp.token;
  await query(`UPDATE core.api_keys SET valid_until = now() - interval '1 day' WHERE key_prefix = $1`, [exp.key_prefix]);
});

describe("apiKeyAuthMiddleware (auth activée)", () => {
  it("chemins publics accessibles sans clé", async () => {
    _resetBuckets();
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/openapi.json")).status).toBe(200);
  });

  it("401 sans token sur un endpoint data", async () => {
    _resetBuckets();
    const res = await app.request("/clubs");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("401 token invalide", async () => {
    _resetBuckets();
    const res = await app.request("/clubs", { headers: { Authorization: "Bearer ffhb_invalidtoken" } });
    expect(res.status).toBe(401);
  });

  it("401 token expiré", async () => {
    _resetBuckets();
    const res = await app.request("/clubs", { headers: { Authorization: `Bearer ${expiredToken}` } });
    expect(res.status).toBe(401);
  });

  it("200 avec token valide (Bearer)", async () => {
    _resetBuckets();
    const res = await app.request("/clubs?limit=1", { headers: { Authorization: `Bearer ${validToken}` } });
    expect(res.status).toBe(200);
  });

  it("200 avec token valide (X-API-Key)", async () => {
    _resetBuckets();
    const res = await app.request("/clubs?limit=1", { headers: { "X-API-Key": validToken } });
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    await query(`DELETE FROM core.api_keys WHERE label LIKE 'TEST-AUTH-%'`);
  });
});

describe("auth désactivée (défaut)", () => {
  it("accès libre sans token", async () => {
    _resetBuckets();
    const free = buildApp(); // authEnabled défaut = env (false en test)
    const res = await free.request("/clubs?limit=1");
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    await closePool();
  });
});
