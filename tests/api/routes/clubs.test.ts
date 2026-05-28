// tests/api/routes/clubs.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

describe("GET /clubs", () => {
  beforeEach(async () => {
    _resetBuckets();
    await query(`DELETE FROM core.clubs WHERE id_ffhb IN ('C001', 'C002')`);
  });

  it("returns paginated list with meta", async () => {
    await seedClub("C001", "BREST HBC", "Brest");
    await seedClub("C002", "PARIS 92", "Paris");
    const res = await app.request("/clubs?limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number; limit: number; offset: number } };
    // At least C001 and C002 should be present (other tests may add clubs concurrently)
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.meta.total).toBeGreaterThanOrEqual(2);
    expect(body.meta.limit).toBe(10);
  });

  it("filters by fuzzy q", async () => {
    await seedClub("C001", "BREST BRETAGNE HANDBALL", "Brest");
    await seedClub("C002", "PARIS 92", "Paris");
    const res = await app.request("/clubs?q=brest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { nom: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.nom).toContain("BREST");
  });

  it("returns 200 with empty data when no matches", async () => {
    const res = await app.request("/clubs?q=xyzzz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });
});

describe("GET /clubs/:id_ffhb", () => {
  beforeEach(async () => {
    _resetBuckets();
    await query(`DELETE FROM core.clubs WHERE id_ffhb IN ('C001', 'C002')`);
  });

  it("returns detail with 200", async () => {
    await seedClub("C001", "BREST HBC", "Brest");
    const res = await app.request("/clubs/C001");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb: string; nom: string } };
    expect(body.data.id_ffhb).toBe("C001");
    expect(body.data.nom).toBe("BREST HBC");
  });

  it("returns 404 when club not found", async () => {
    const res = await app.request("/clubs/GHOST");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  afterAll(async () => {
    await closePool();
  });
});
