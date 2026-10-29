// tests/api/routes/status-integrite.test.ts — /status expose les contrôles d'intégrité de la base.
import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

describe("GET /status — intégrité", () => {
  it("renvoie les six contrôles et signale la contrainte matchs → poules", async () => {
    _resetBuckets();
    const res = await buildApp().request("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrite: { key: string; ok: boolean }[] };
    expect(body.integrite.map((c) => c.key)).toEqual(["matchs", "poules", "equipes", "clubs", "matchs_sans_poule", "fk_matchs_poule"]);
    expect(body.integrite.find((c) => c.key === "matchs_sans_poule")!.ok).toBe(true);
    expect(body.integrite.find((c) => c.key === "fk_matchs_poule")!.ok).toBe(true);
  });
  afterAll(async () => {
    await closePool();
  });
});
