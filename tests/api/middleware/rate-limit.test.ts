// tests/api/middleware/rate-limit.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

describe("rate-limit middleware", () => {
  beforeEach(() => _resetBuckets());

  it("allows requests under the limit", async () => {
    const app = buildApp();
    const res = await app.request("/health", { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Remaining")).not.toBeNull();
  });

  it("returns 429 when limit exceeded", async () => {
    const app = buildApp();
    // Hammer 70 requests on same IP
    const ip = "2.2.2.2";
    let lastStatus = 0;
    for (let i = 0; i < 70; i++) {
      const res = await app.request("/health", { headers: { "x-forwarded-for": ip } });
      lastStatus = res.status;
    }
    // Last requests should be 429
    expect(lastStatus).toBe(429);
  });

  it("includes rate-limit headers", async () => {
    const app = buildApp();
    const res = await app.request("/health", { headers: { "x-forwarded-for": "3.3.3.3" } });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
  });
});

describe("rate-limit — IP du client derrière nginx", () => {
  beforeEach(() => _resetBuckets());

  it("ignore une première entrée X-Forwarded-For falsifiée (contournement impossible)", async () => {
    const app = buildApp();
    let last = 0;
    // Le client change d'IP « annoncée » à chaque requête ; nginx ajoute sa vraie IP en dernier.
    for (let i = 0; i < 70; i++) {
      const res = await app.request("/health", { headers: { "x-forwarded-for": `10.0.0.${i}, 9.9.9.9` } });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("X-Real-IP prime sur X-Forwarded-For", async () => {
    const app = buildApp();
    let last = 0;
    for (let i = 0; i < 70; i++) {
      const res = await app.request("/health", {
        headers: { "x-real-ip": "8.8.8.8", "x-forwarded-for": `1.2.3.${i}` },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
