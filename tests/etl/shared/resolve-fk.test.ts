import { afterAll, describe, it, expect } from "vitest";
import { query, closePool } from "@/db/client.js";
import { resolveDepartementId } from "@/etl/shared/resolve-fk.js";

describe("resolveDepartementId", () => {
  afterAll(async () => {
    await closePool();
  });

  it("returns id for existing dept code", async () => {
    const r = await query<{ id: number }>(
      `SELECT id FROM core.departements WHERE code = '75'`,
    );
    const expected = r.rows[0]!.id;
    const got = await resolveDepartementId("75");
    expect(got).toBe(expected);
  });

  it("returns null for unknown dept code", async () => {
    expect(await resolveDepartementId("999")).toBeNull();
  });

  it("returns null for nullish input", async () => {
    expect(await resolveDepartementId(undefined)).toBeNull();
  });
});
