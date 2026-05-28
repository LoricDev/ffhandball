// tests/api/routes/classements.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();

interface SeedIds {
  pouleIdFfhb: string;
  pouleId: bigint;
  equipeId: bigint;
}

async function seedClassementHierarchy(): Promise<SeedIds> {
  const saisonCode = "2025-2026";
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [saisonCode],
  );
  const compRes = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('COMP-T5', 'Championnat Test T5', 'national', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const competitionId = compRes.rows[0]!.id;
  const phaseRes = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('PH-T5', $1, 'Phase Test T5', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [competitionId, saisonCode],
  );
  const phaseId = phaseRes.rows[0]!.id;
  const pouleIdFfhb = "PO-T5";
  const pouleRes = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ($1, $2, 'Poule Test T5', $3, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [pouleIdFfhb, phaseId, saisonCode],
  );
  const pouleId = pouleRes.rows[0]!.id;
  const eqRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('EQ-T5-001', 'Equipe T5 Alpha', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const equipeId = eqRes.rows[0]!.id;
  return { pouleIdFfhb, pouleId, equipeId };
}

describe("GET /classements", () => {
  let ids: SeedIds;

  beforeAll(async () => {
    ids = await seedClassementHierarchy();
    // Insert classement entry
    await query(
      `INSERT INTO core.classements (poule_id, equipe_id, position, points, joues, gagnes, nuls, perdus, buts_pour, buts_contre, capture_date)
       VALUES ($1, $2, 1, 9, 3, 3, 0, 0, 90, 60, now())
       ON CONFLICT (poule_id, equipe_id) DO UPDATE SET points = EXCLUDED.points`,
      [ids.pouleId, ids.equipeId],
    );
  });

  beforeEach(() => {
    _resetBuckets();
  });

  it("returns classement data for valid poule_id_ffhb", async () => {
    const res = await app.request(`/classements?poule_id_ffhb=${ids.pouleIdFfhb}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { position: number; points: number; equipe_nom: string; equipe_id_ffhb: string }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.position).toBe(1);
    expect(body.data[0]!.points).toBe(9);
    expect(body.data[0]!.equipe_nom).toBe("Equipe T5 Alpha");
    expect(body.data[0]!.equipe_id_ffhb).toBe("EQ-T5-001");
  });

  it("returns 400 when poule_id_ffhb is missing", async () => {
    const res = await app.request("/classements");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 when poule not found or no classement", async () => {
    const res = await app.request("/classements?poule_id_ffhb=PO-GHOST-999");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  afterAll(async () => {
    await closePool();
  });
});
