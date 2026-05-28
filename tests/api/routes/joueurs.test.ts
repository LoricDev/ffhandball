// tests/api/routes/joueurs.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();

interface SeedIds {
  joueurId: bigint;
  matchId: bigint;
  equipeId: bigint;
}

async function seedJoueurWithMatch(): Promise<SeedIds> {
  const saisonCode = "2025-2026";
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [saisonCode],
  );
  // Competition hierarchy
  const compRes = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('COMP-T6', 'Championnat Test T6', 'national', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const competitionId = compRes.rows[0]!.id;
  const phaseRes = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('PH-T6', $1, 'Phase T6', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [competitionId, saisonCode],
  );
  const phaseId = phaseRes.rows[0]!.id;
  const pouleRes = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ('PO-T6', $1, 'Poule T6', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [phaseId, saisonCode],
  );
  const pouleId = pouleRes.rows[0]!.id;
  // Equipes
  const edRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('EQ-T6-DOM', 'Equipe T6 Dom', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const equipeDomId = edRes.rows[0]!.id;
  const eeRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('EQ-T6-EXT', 'Equipe T6 Ext', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
    [saisonCode],
  );
  const equipeExtId = eeRes.rows[0]!.id;
  // Match
  const matchRes = await query<{ id: bigint }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut, score_dom, score_ext)
     VALUES ('M-T6-001', $1, $2, $3, now(), 'joue', 30, 25)
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut
     RETURNING id`,
    [pouleId, equipeDomId, equipeExtId],
  );
  const matchId = matchRes.rows[0]!.id;
  // Joueur
  const joueurRes = await query<{ id: bigint }>(
    `INSERT INTO core.joueurs (numero_licence, nom, prenom, last_seen_at)
     VALUES ('LIC-T6-007', 'MARTIN', 'Luc', now())
     ON CONFLICT (numero_licence) DO UPDATE SET nom = EXCLUDED.nom
     RETURNING id`,
  );
  const joueurId = joueurRes.rows[0]!.id;
  // Composition
  await query(
    `INSERT INTO core.match_compositions (match_id, joueur_id, equipe_id, numero_maillot, but_count, tirs_count, arrets_count)
     VALUES ($1, $2, $3, 7, 5, 10, 0)
     ON CONFLICT (match_id, joueur_id) DO UPDATE SET but_count = EXCLUDED.but_count`,
    [matchId, joueurId, equipeDomId],
  );
  return { joueurId, matchId, equipeId: equipeDomId };
}

describe("GET /joueurs/:numero_licence", () => {
  beforeAll(async () => {
    await seedJoueurWithMatch();
  });

  beforeEach(() => {
    _resetBuckets();
  });

  it("returns joueur detail with stats and historique", async () => {
    const res = await app.request("/joueurs/LIC-T6-007");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        numero_licence: string;
        nom: string;
        prenom: string;
        stats: {
          total_buts: number;
          total_matchs: number;
          total_tirs: number;
        };
        historique: Array<{
          id_ffhb_match: string;
          buts: number;
          equipe_joueur_nom: string;
        }>;
      };
    };
    expect(body.data.numero_licence).toBe("LIC-T6-007");
    expect(body.data.nom).toBe("MARTIN");
    expect(body.data.prenom).toBe("Luc");
    expect(body.data.stats.total_buts).toBe(5);
    expect(body.data.stats.total_matchs).toBe(1);
    expect(body.data.stats.total_tirs).toBe(10);
    expect(Array.isArray(body.data.historique)).toBe(true);
    expect(body.data.historique).toHaveLength(1);
  });

  it("returns 404 when joueur not found", async () => {
    const res = await app.request("/joueurs/LIC-GHOST-999");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("verifies historique format", async () => {
    const res = await app.request("/joueurs/LIC-T6-007");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        historique: Array<{
          id_ffhb_match: string;
          equipe_dom_nom: string;
          equipe_ext_nom: string;
          equipe_joueur_nom: string;
          buts: number;
          tirs: number;
          arrets: number;
        }>;
      };
    };
    const h = body.data.historique[0]!;
    expect(h.id_ffhb_match).toBe("M-T6-001");
    expect(h.equipe_dom_nom).toBe("Equipe T6 Dom");
    expect(h.equipe_ext_nom).toBe("Equipe T6 Ext");
    expect(h.equipe_joueur_nom).toBe("Equipe T6 Dom");
    expect(h.buts).toBe(5);
    expect(h.tirs).toBe(10);
    expect(h.arrets).toBe(0);
  });

  afterAll(async () => {
    await closePool();
  });
});
