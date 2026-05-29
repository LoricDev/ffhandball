// tests/api/routes/competitions.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();
const SAISON = "2025-2026";

let pouleId: bigint;
let equipeId: bigint;

beforeAll(async () => {
  await query(`DELETE FROM core.classements WHERE id_ffhb = 'CMPT1-CL-1'`);
  await query(`DELETE FROM core.equipes WHERE id_ffhb = 'CMPT1-EQ' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.poules WHERE id_ffhb = 'CMPT1-PO' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.phases WHERE id_ffhb = 'CMPT1-PH' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.competitions WHERE id_ffhb = 'CMPT1-COMP'`);

  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30') ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
  const comp = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, sexe, saison_code, last_seen_at)
     VALUES ('CMPT1-COMP', 'Championnat Test Tier1', 'national', 'F', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const ph = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('CMPT1-PH', $1, 'Phase 1', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const po = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ('CMPT1-PO', $1, 'Poule A', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [ph.rows[0]!.id, SAISON],
  );
  pouleId = po.rows[0]!.id;
  const eq = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('CMPT1-EQ', 'EQUIPE TEST T1', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  equipeId = eq.rows[0]!.id;
  await query(
    `INSERT INTO core.classements (id_ffhb, poule_id, equipe_id, position, points, joues, gagnes, nuls, perdus, buts_pour, buts_contre, capture_date)
     VALUES ('CMPT1-CL-1', $1, $2, 1, 6, 2, 2, 0, 0, 50, 40, now())
     ON CONFLICT DO NOTHING`,
    [pouleId, equipeId],
  );
});

describe("GET /competitions", () => {
  it("liste les compétitions filtrées par saison/niveau", async () => {
    _resetBuckets();
    const res = await app.request("/competitions?saison=2025-2026&niveau=national&limit=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb: string; niveau: string }[]; meta: { total: number } };
    const found = body.data.find((c) => c.id_ffhb === "CMPT1-COMP");
    expect(found).toBeDefined();
    expect(found!.niveau).toBe("national");
  });
});

describe("GET /competitions/:id_ffhb", () => {
  it("retourne le détail avec phases + poules", async () => {
    _resetBuckets();
    const res = await app.request("/competitions/CMPT1-COMP");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id_ffhb: string; phases: { id_ffhb: string; poules: { id_ffhb: string }[] }[] };
    };
    expect(body.data.id_ffhb).toBe("CMPT1-COMP");
    const phase = body.data.phases.find((p) => p.id_ffhb === "CMPT1-PH");
    expect(phase).toBeDefined();
    expect(phase!.poules.map((p) => p.id_ffhb)).toContain("CMPT1-PO");
  });

  it("404 si compétition inconnue", async () => {
    _resetBuckets();
    const res = await app.request("/competitions/GHOST");
    expect(res.status).toBe(404);
  });
});

describe("GET /poules/:id_ffhb", () => {
  it("retourne la poule avec contexte + classement", async () => {
    _resetBuckets();
    const res = await app.request("/poules/CMPT1-PO?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id_ffhb: string;
        competition: { id_ffhb: string; niveau: string | null };
        phase: { id_ffhb: string };
        classement: { equipe_id_ffhb: string; position: number }[];
      };
    };
    expect(body.data.id_ffhb).toBe("CMPT1-PO");
    expect(body.data.competition.id_ffhb).toBe("CMPT1-COMP");
    expect(body.data.phase.id_ffhb).toBe("CMPT1-PH");
    expect(body.data.classement.find((c) => c.equipe_id_ffhb === "CMPT1-EQ")).toBeDefined();
  });

  it("404 si poule inconnue", async () => {
    _resetBuckets();
    const res = await app.request("/poules/GHOST?saison=2025-2026");
    expect(res.status).toBe(404);
  });

  afterAll(async () => {
    await closePool();
  });
});
