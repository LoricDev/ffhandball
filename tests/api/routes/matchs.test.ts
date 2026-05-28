// tests/api/routes/matchs.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();

interface SeedIds {
  saisonCode: string;
  competitionId: bigint;
  phaseId: bigint;
  pouleId: bigint;
  pouleIdFfhb: string;
  equipeDomId: bigint;
  equipeExtId: bigint;
}

async function seedHierarchy(): Promise<SeedIds> {
  const saisonCode = "2025-2026";
  // Saison
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [saisonCode],
  );
  // Competition
  const compRes = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('COMP-T4', 'Championnat Test T4', 'national', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const competitionId = compRes.rows[0]!.id;
  // Phase
  const phaseRes = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('PH-T4', $1, 'Phase Test T4', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [competitionId, saisonCode],
  );
  const phaseId = phaseRes.rows[0]!.id;
  // Poule
  const pouleIdFfhb = "PO-T4";
  const pouleRes = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ($1, $2, 'Poule Test T4', $3, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [pouleIdFfhb, phaseId, saisonCode],
  );
  const pouleId = pouleRes.rows[0]!.id;
  // Equipes
  const edRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('EQ-DOM-T4', 'Equipe Dom T4', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const equipeDomId = edRes.rows[0]!.id;
  const eeRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('EQ-EXT-T4', 'Equipe Ext T4', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const equipeExtId = eeRes.rows[0]!.id;
  return { saisonCode, competitionId, phaseId, pouleId, pouleIdFfhb, equipeDomId, equipeExtId };
}

async function seedMatch(
  ids: SeedIds,
  idFfhbMatch: string,
  statut: string = "joue",
): Promise<{ matchId: bigint }> {
  const r = await query<{ id: bigint }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut, score_dom, score_ext)
     VALUES ($1, $2, $3, $4, now(), $5, 28, 24)
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut
     RETURNING id`,
    [idFfhbMatch, ids.pouleId, ids.equipeDomId, ids.equipeExtId, statut],
  );
  return { matchId: r.rows[0]!.id };
}

describe("GET /matchs", () => {
  let ids: SeedIds;

  beforeAll(async () => {
    await query(`
      DELETE FROM core.match_officiels WHERE match_id IN (SELECT id FROM core.matchs WHERE id_ffhb_match LIKE 'M-T4-%');
      DELETE FROM core.match_compositions WHERE match_id IN (SELECT id FROM core.matchs WHERE id_ffhb_match LIKE 'M-T4-%');
      DELETE FROM core.match_actions WHERE match_id IN (SELECT id FROM core.matchs WHERE id_ffhb_match LIKE 'M-T4-%');
      DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'M-T4-%';
    `);
    ids = await seedHierarchy();
  });

  beforeEach(() => {
    _resetBuckets();
  });

  it("returns paginated list filtered by poule_id_ffhb", async () => {
    await seedMatch(ids, "M-T4-001", "joue");
    await seedMatch(ids, "M-T4-002", "a_jouer");
    const res = await app.request(`/matchs?poule_id_ffhb=${ids.pouleIdFfhb}&limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number } };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it("filters by statut", async () => {
    await seedMatch(ids, "M-T4-003", "reporte");
    const res = await app.request(`/matchs?statut=reporte&limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { statut: string }[] };
    for (const m of body.data) {
      expect(m.statut).toBe("reporte");
    }
  });
});

describe("GET /matchs/:id_ffhb_match", () => {
  let ids: SeedIds;

  beforeAll(async () => {
    ids = await seedHierarchy();
  });

  beforeEach(() => {
    _resetBuckets();
  });

  it("returns enriched detail with compositions, actions, officiels", async () => {
    const { matchId } = await seedMatch(ids, "M-T4-DETAIL", "joue");
    // Seed a joueur + composition
    const joueurRes = await query<{ id: bigint }>(
      `INSERT INTO core.joueurs (numero_licence, nom, prenom, last_seen_at)
       VALUES ('LIC-T4-001', 'DUPONT', 'Jean', now())
       ON CONFLICT (numero_licence) DO UPDATE SET nom = EXCLUDED.nom
       RETURNING id`,
    );
    const joueurId = joueurRes.rows[0]!.id;
    await query(
      `INSERT INTO core.match_compositions (match_id, joueur_id, equipe_id, numero_maillot, capitaine, gardien)
       VALUES ($1, $2, $3, 7, false, false)
       ON CONFLICT (match_id, joueur_id) DO NOTHING`,
      [matchId, joueurId, ids.equipeDomId],
    );

    const res = await app.request(`/matchs/M-T4-DETAIL`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id_ffhb_match: string;
        compositions: unknown[];
        actions: unknown[];
        officiels: unknown[];
        equipe_dom_nom: string;
        equipe_ext_nom: string;
      };
    };
    expect(body.data.id_ffhb_match).toBe("M-T4-DETAIL");
    expect(body.data.equipe_dom_nom).toBe("Equipe Dom T4");
    expect(body.data.equipe_ext_nom).toBe("Equipe Ext T4");
    expect(Array.isArray(body.data.compositions)).toBe(true);
    expect(body.data.compositions).toHaveLength(1);
    expect(Array.isArray(body.data.actions)).toBe(true);
    expect(Array.isArray(body.data.officiels)).toBe(true);
  });

  it("returns 404 when match not found", async () => {
    const res = await app.request("/matchs/GHOST-MATCH");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  afterAll(async () => {
    await closePool();
  });
});
