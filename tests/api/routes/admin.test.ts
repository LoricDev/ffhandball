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
    await closePool();
  });
});
