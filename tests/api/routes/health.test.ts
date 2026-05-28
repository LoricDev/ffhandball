// tests/api/routes/health.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import type { OpenAPIHono } from "@hono/zod-openapi";

let app: OpenAPIHono;

beforeAll(() => {
  app = buildApp();
});

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("GET /ready", () => {
  it("returns 200 when DB is reachable", async () => {
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe("ready");
    expect(body.db).toBe("connected");
  });
});
