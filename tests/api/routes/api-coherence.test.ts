// tests/api/routes/api-coherence.test.ts — conventions communes à tous les endpoints.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";
import { toDayString } from "@/api/lib/dates.js";
import { searchQuerySchema } from "@/api/schemas/search.api.js";

const app = buildApp();
const SAISON = "2025-2026";

describe("toDayString", () => {
  it("formate une Date minuit local en YYYY-MM-DD, sans décalage de fuseau", () => {
    expect(toDayString(new Date(2002, 2, 5))).toBe("2002-03-05");
  });
  it("tronque une chaîne ISO", () => {
    expect(toDayString("2002-03-05T00:00:00.000Z")).toBe("2002-03-05");
  });
});

describe("search : vocabulaire de type", () => {
  it("accepte le singulier (celui des résultats) et le pluriel historique", () => {
    expect(searchQuerySchema.parse({ q: "ab", type: "club" }).type).toBe("clubs");
    expect(searchQuerySchema.parse({ q: "ab", type: "joueurs" }).type).toBe("joueurs");
  });
});

describe("conventions", () => {
  beforeAll(async () => {
    await query(`DELETE FROM core.poules WHERE id_ffhb = 'COH-PO'`);
    await query(`DELETE FROM core.phases WHERE id_ffhb = 'COH-PH'`);
    await query(`DELETE FROM core.competitions WHERE id_ffhb = 'COH-COMP'`);
    await query(
      `INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1, '2025-09-01', '2026-06-30') ON CONFLICT DO NOTHING`,
      [SAISON],
    );
    const comp = await query<{ id: bigint }>(
      `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at) VALUES ('COH-COMP', 'Comp COH', 'national', $1, now()) RETURNING id`,
      [SAISON],
    );
    const ph = await query<{ id: bigint }>(
      `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at) VALUES ('COH-PH', $1, 'Ph', $2, now()) RETURNING id`,
      [comp.rows[0]!.id, SAISON],
    );
    await query(
      `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at) VALUES ('COH-PO', $1, 'Po', $2, now())`,
      [ph.rows[0]!.id, SAISON],
    );
  });

  it("/saisons : dates en YYYY-MM-DD", async () => {
    _resetBuckets();
    const body = (await (await app.request("/saisons")).json()) as { data: { saison_code: string; date_debut: string }[] };
    const s = body.data.find((x) => x.saison_code === SAISON)!;
    expect(s.date_debut).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("/classements et /stats-joueurs : poule existante sans données → 200 liste vide", async () => {
    _resetBuckets();
    const c = await app.request("/classements?poule_id_ffhb=COH-PO");
    expect(c.status).toBe(200);
    expect(((await c.json()) as { data: unknown[] }).data).toEqual([]);
    _resetBuckets();
    const s = await app.request("/stats-joueurs?poule_id_ffhb=COH-PO");
    expect(s.status).toBe(200);
  });

  it("/classements : poule inconnue → 404", async () => {
    _resetBuckets();
    expect((await app.request("/classements?poule_id_ffhb=COH-GHOST")).status).toBe(404);
  });

  it("/joueurs/{l}/matchs et /arbitres/{id}/matchs acceptent tri", async () => {
    _resetBuckets();
    expect((await app.request("/joueurs/GHOST/matchs?tri=date_desc")).status).toBe(404);
    _resetBuckets();
    expect((await app.request("/arbitres/GHOST/matchs?tri=bad")).status).toBe(400);
  });

  afterAll(async () => {
    await query(`DELETE FROM core.poules WHERE id_ffhb = 'COH-PO'`);
    await query(`DELETE FROM core.phases WHERE id_ffhb = 'COH-PH'`);
    await query(`DELETE FROM core.competitions WHERE id_ffhb = 'COH-COMP'`);
    await closePool();
  });
});
