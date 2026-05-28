// tests/integration/api-end-to-end.test.ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();

async function seedClub(id_ffhb: string, nom: string, ville?: string): Promise<void> {
  await query(
    `INSERT INTO core.clubs (id_ffhb, nom, ville, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
    [id_ffhb, nom, ville ?? null],
  );
}

describe("API end-to-end (smoke)", () => {
  beforeEach(async () => {
    _resetBuckets();
  });

  it("GET /openapi.json returns valid OpenAPI 3.1 spec with all routes", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.paths["/health"]).toBeDefined();
    expect(spec.paths["/clubs"]).toBeDefined();
    expect(spec.paths["/matchs"]).toBeDefined();
    expect(spec.paths["/classements"]).toBeDefined();
    expect(spec.paths["/joueurs/{numero_licence}"]).toBeDefined();
    expect(spec.paths["/search"]).toBeDefined();
  });

  it("GET /docs serves Swagger UI HTML", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("html");
  });

  it("full chain : seed minimal → list → detail → search", async () => {
    const TEST_ID = "E2E_BREST_001";
    await query(`DELETE FROM core.clubs WHERE id_ffhb = $1`, [TEST_ID]);
    await seedClub(TEST_ID, "BREST BRETAGNE HANDBALL", "Brest");

    // List with fuzzy search
    const listRes = await app.request("/clubs?q=brest");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { id_ffhb: string; nom: string }[] };
    const found = listBody.data.find((c) => c.id_ffhb === TEST_ID);
    expect(found).toBeDefined();
    expect(found!.nom).toContain("BREST");

    // Detail
    const detailRes = await app.request(`/clubs/${TEST_ID}`);
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as { data: { id_ffhb: string } };
    expect(detailBody.data.id_ffhb).toBe(TEST_ID);

    // Search
    const searchRes = await app.request("/search?q=brest");
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { data: unknown[] };
    expect(searchBody.data.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    await query(`DELETE FROM core.clubs WHERE id_ffhb = $1`, [TEST_ID]);
  });

  afterAll(async () => {
    await closePool();
  });
});
