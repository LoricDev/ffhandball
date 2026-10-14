// tests/api/routes/admin.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();
const SECRET = "test-admin-secret-0123456789"; // ≥16 chars
const prevSecret = process.env.ADMIN_SECRET;

beforeAll(async () => {
  await query(`DELETE FROM core.api_keys WHERE label LIKE 'TEST-ADMIN-%'`);
});

describe("admin /admin/api-keys — garde X-Admin-Secret", () => {
  it("503 si ADMIN_SECRET non configuré", async () => {
    _resetBuckets();
    delete process.env.ADMIN_SECRET;
    const res = await app.request("/admin/api-keys", { method: "POST", body: JSON.stringify({ label: "x" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(503);
  });

  it("401 si mauvais secret", async () => {
    _resetBuckets();
    process.env.ADMIN_SECRET = SECRET;
    const res = await app.request("/admin/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "wrong" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("create → renew → revoke avec le bon secret", async () => {
    _resetBuckets();
    process.env.ADMIN_SECRET = SECRET;
    const h = { "content-type": "application/json", "x-admin-secret": SECRET };

    // create
    const createRes = await app.request("/admin/api-keys", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ label: "TEST-ADMIN-1", months: 1 }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { data: { token: string; key_prefix: string; valid_until: string } };
    expect(created.data.token).toMatch(/^ffhb_/);
    const prefix = created.data.key_prefix;

    // renew
    const renewRes = await app.request(`/admin/api-keys/${prefix}/renew`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ months: 2 }),
    });
    expect(renewRes.status).toBe(200);

    // revoke
    const revokeRes = await app.request(`/admin/api-keys/${prefix}/revoke`, { method: "POST", headers: h });
    expect(revokeRes.status).toBe(200);

    // renew d'un préfixe inconnu → 404
    const notFound = await app.request(`/admin/api-keys/ffhb_00000000/renew`, { method: "POST", headers: h, body: "{}" });
    expect(notFound.status).toBe(404);
  });

  afterAll(async () => {
    await query(`DELETE FROM core.api_keys WHERE label LIKE 'TEST-ADMIN-%'`);
    if (prevSecret === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = prevSecret;
  });
});

// Fermeture du pool au niveau du fichier : après TOUS les describe (un afterAll de describe la ferait trop tôt).
afterAll(async () => {
  await closePool();
});

describe("admin /admin/pipeline + /admin/dashboard", () => {
  it("dashboard HTML accessible sans secret", async () => {
    _resetBuckets();
    process.env.ADMIN_SECRET = SECRET;
    const res = await app.request("/admin/dashboard");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Administration");
  });

  it("pipeline: 401 sans secret, 200 avec", async () => {
    _resetBuckets();
    process.env.ADMIN_SECRET = SECRET;
    expect((await app.request("/admin/pipeline")).status).toBe(401);
    const res = await app.request("/admin/pipeline", { headers: { "x-admin-secret": SECRET } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(Array.isArray(data.scrapes)).toBe(true);
    expect(Array.isArray(data.etls)).toBe(true);
    expect(data.db.bytes).toBeDefined();
  });
});

describe("admin : validation, trafic, webhooks", () => {
  const h = { "content-type": "application/json", "x-admin-secret": SECRET };

  it("refuse un corps invalide à la création de clé (400)", async () => {
    _resetBuckets();
    process.env.ADMIN_SECRET = SECRET;
    for (const body of [{ months: -1 }, { months: "3" }, { rate_limit_per_min: 0 }, { label: "x".repeat(300) }]) {
      const res = await app.request("/admin/api-keys", { method: "POST", headers: h, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
  });

  it("/admin/traffic : structure complète, fenêtre inconnue → 24 h", async () => {
    _resetBuckets();
    process.env.ADMIN_SECRET = SECRET;
    expect((await app.request("/admin/traffic")).status).toBe(401);
    const res = await app.request("/admin/traffic?hours=999", { headers: h });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.hours).toBe(24);
    expect(data.series).toHaveLength(24);
    expect(data.totals).toHaveProperty("p95_ms");
    expect(Array.isArray(data.top_routes)).toBe(true);
    expect(Array.isArray(data.top_keys)).toBe(true);
  });

  it("webhooks : protégés par le secret, URL non HTTPS refusée, liste accessible", async () => {
    _resetBuckets();
    process.env.ADMIN_SECRET = SECRET;
    expect((await app.request("/admin/webhooks")).status).toBe(401);
    const bad = await app.request("/admin/webhooks", { method: "POST", headers: h, body: JSON.stringify({ url: "http://exemple.fr/hook" }) });
    expect(bad.status).toBe(400);
    const internal = await app.request("/admin/webhooks", { method: "POST", headers: h, body: JSON.stringify({ url: "https://127.0.0.1/hook" }) });
    expect(internal.status).toBe(400);
    const list = await app.request("/admin/webhooks", { headers: h });
    expect(list.status).toBe(200);
    expect(Array.isArray((await list.json()).data)).toBe(true);
  });
});
