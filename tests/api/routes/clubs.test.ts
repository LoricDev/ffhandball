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

// ── Helpers pour les tests calendrier ──────────────────────────────────────

interface CalSeedIds {
  saisonCode: string;
  competitionId: bigint;
  phaseId: bigint;
  pouleId: bigint;
  pouleIdFfhb: string;
  equipeMainId: bigint;
  equipeReserveId: bigint;
  equipeEntenteId: bigint;
  equipeAutreId: bigint;
  equipeAdverseId: bigint;
}

async function seedCalHierarchy(): Promise<CalSeedIds> {
  const saisonCode = "2025-2026";
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30') ON CONFLICT (saison_code) DO NOTHING`,
    [saisonCode],
  );
  const compRes = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('CAL-COMP-01', 'Championnat Cal Test', 'national', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [saisonCode],
  );
  const competitionId = compRes.rows[0]!.id;

  const phaseRes = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('CAL-PH-01', $1, 'Phase Cal', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [competitionId, saisonCode],
  );
  const phaseId = phaseRes.rows[0]!.id;

  const pouleIdFfhb = "CAL-PO-01";
  const pouleRes = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ($1, $2, 'Poule Cal', $3, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [pouleIdFfhb, phaseId, saisonCode],
  );
  const pouleId = pouleRes.rows[0]!.id;

  // Équipe principale (nom exact = club.nom)
  const mainRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('CAL-EQ-MAIN', 'BREST BRETAGNE HANDBALL', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [saisonCode],
  );
  const equipeMainId = mainRes.rows[0]!.id;

  // Équipe réserve (club.nom + suffixe)
  const resRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('CAL-EQ-RES', 'BREST BRETAGNE HANDBALL 2', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [saisonCode],
  );
  const equipeReserveId = resRes.rows[0]!.id;

  // Équipe entente (contient ENTENTE + mot distinctif BREST)
  const entRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('CAL-EQ-ENT', 'ENTENTE BREST PLOUDA', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [saisonCode],
  );
  const equipeEntenteId = entRes.rows[0]!.id;

  // Équipe non liée (adversaire générique)
  const autreRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('CAL-EQ-AUTRE', 'PARIS 92', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [saisonCode],
  );
  const equipeAutreId = autreRes.rows[0]!.id;

  // Équipe adversaire distincte (pour les matchs du type "non lié vs non lié")
  const adverseRes = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('CAL-EQ-ADV', 'MONTPELLIER HB', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [saisonCode],
  );
  const equipeAdverseId = adverseRes.rows[0]!.id;

  return {
    saisonCode,
    competitionId,
    phaseId,
    pouleId,
    pouleIdFfhb,
    equipeMainId,
    equipeReserveId,
    equipeEntenteId,
    equipeAutreId,
    equipeAdverseId,
  };
}

async function seedCalMatch(
  ids: CalSeedIds,
  idFfhbMatch: string,
  equipeHomId: bigint,
  equipeVisId: bigint,
  opts: { statut?: string; dateHeure?: string; scoreDom?: number; scoreExt?: number } = {},
): Promise<void> {
  const statut = opts.statut ?? "joue";
  const dateHeure = opts.dateHeure ?? "2025-10-15T20:00:00Z";
  const scoreDom = opts.scoreDom ?? 28;
  const scoreExt = opts.scoreExt ?? 24;
  await query(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut, score_dom, score_ext)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut, score_dom = EXCLUDED.score_dom, score_ext = EXCLUDED.score_ext`,
    [idFfhbMatch, ids.pouleId, equipeHomId, equipeVisId, dateHeure, statut, scoreDom, scoreExt],
  );
}

describe("GET /clubs", () => {
  beforeEach(async () => {
    _resetBuckets();
    // Nettoie les clubs des tests de cette suite + les clubs calendrier (isolation)
    await query(`DELETE FROM core.clubs WHERE id_ffhb IN ('C001', 'C002', 'CAL-C001', 'CAL-C002')`);
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
    await query(`DELETE FROM core.clubs WHERE id_ffhb IN ('C001', 'C002', 'CAL-C001', 'CAL-C002', '1720')`);
  });

  it("returns detail with 200", async () => {
    await seedClub("C001", "BREST HBC", "Brest");
    const res = await app.request("/clubs/C001");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb: string; nom: string } };
    expect(body.data.id_ffhb).toBe("C001");
    expect(body.data.nom).toBe("BREST HBC");
  });

  it("résout par id_ffhb OU par code_ffhb (7 chiffres) et expose code_ffhb", async () => {
    // Club avec email → code_ffhb généré = "5221105"
    await query(
      `INSERT INTO core.clubs (id_ffhb, nom, email, last_seen_at)
       VALUES ('1720', 'JDA DIJON HANDBALL', '5221105@ffhandball.net', now())
       ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom, email = EXCLUDED.email`,
    );
    // Par id_club
    const byId = await app.request("/clubs/1720");
    expect(byId.status).toBe(200);
    const b1 = (await byId.json()) as { data: { id_ffhb: string; code_ffhb: string | null } };
    expect(b1.data.id_ffhb).toBe("1720");
    expect(b1.data.code_ffhb).toBe("5221105");
    // Par code FFHB 7 chiffres → résout le même club
    const byCode = await app.request("/clubs/5221105");
    expect(byCode.status).toBe(200);
    const b2 = (await byCode.json()) as { data: { id_ffhb: string; code_ffhb: string | null } };
    expect(b2.data.id_ffhb).toBe("1720");
    expect(b2.data.code_ffhb).toBe("5221105");
  });

  it("returns 404 when club not found", async () => {
    const res = await app.request("/clubs/GHOST");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ── GET /clubs/:id_ffhb/matchs ─────────────────────────────────────────────

describe("GET /clubs/:id_ffhb/matchs", () => {
  let ids: CalSeedIds;

  beforeAll(async () => {
    // Nettoyage préalable des données de test calendrier
    await query(`
      DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'CAL-M-%';
    `);
    await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'CAL-EQ-%' AND saison_code = '2025-2026'`);
    await query(`DELETE FROM core.poules WHERE id_ffhb = 'CAL-PO-01' AND saison_code = '2025-2026'`);
    await query(`DELETE FROM core.phases WHERE id_ffhb = 'CAL-PH-01' AND saison_code = '2025-2026'`);
    await query(`DELETE FROM core.competitions WHERE id_ffhb = 'CAL-COMP-01'`);
    await query(`DELETE FROM core.equipes WHERE id_ffhb = 'CAL-EQ-FP' AND saison_code = '2025-2026'`);
    await query(`DELETE FROM core.clubs WHERE id_ffhb IN ('CAL-C001', 'CAL-C002', 'CAL-C003')`);

    // Seed club principal
    await query(
      `INSERT INTO core.clubs (id_ffhb, nom, ville, last_seen_at)
       VALUES ('CAL-C001', 'BREST BRETAGNE HANDBALL', 'Brest', now())
       ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
    );

    // Seed hiérarchie compétition/phase/poule + 4 équipes
    ids = await seedCalHierarchy();

    // Seed matchs :
    // M1 : équipe principale à domicile
    await seedCalMatch(ids, "CAL-M-001", ids.equipeMainId, ids.equipeAutreId, {
      statut: "joue",
      dateHeure: "2025-10-01T20:00:00Z",
    });
    // M2 : équipe réserve à l'extérieur
    await seedCalMatch(ids, "CAL-M-002", ids.equipeAutreId, ids.equipeReserveId, {
      statut: "joue",
      dateHeure: "2025-10-08T20:00:00Z",
    });
    // M3 : équipe entente à domicile
    await seedCalMatch(ids, "CAL-M-003", ids.equipeEntenteId, ids.equipeAutreId, {
      statut: "a_jouer",
      dateHeure: "2025-11-01T20:00:00Z",
      scoreDom: null as unknown as number,
      scoreExt: null as unknown as number,
    });
    // M4 : match entre deux équipes non liées (ne doit pas apparaître)
    await seedCalMatch(ids, "CAL-M-004", ids.equipeAutreId, ids.equipeAdverseId, {
      statut: "joue",
      dateHeure: "2025-10-15T20:00:00Z",
    });
  });

  beforeEach(() => {
    _resetBuckets();
  });

  it("returns matchs for principal + reserve teams by default", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026&include_ententes=false");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id_ffhb_match: string; via_principal: boolean; via_entente: boolean }[];
      meta: { total: number; club: { nom: string }; equipes_liees: unknown[] };
    };
    // M1 (principal) + M2 (réserve) → 2 matchs, pas M3 (entente), pas M4 (non lié)
    expect(body.meta.total).toBe(2);
    expect(body.data).toHaveLength(2);
    const ids_matchs = body.data.map((m) => m.id_ffhb_match);
    expect(ids_matchs).toContain("CAL-M-001");
    expect(ids_matchs).toContain("CAL-M-002");
    expect(ids_matchs).not.toContain("CAL-M-003");
    expect(ids_matchs).not.toContain("CAL-M-004");
    // via_principal sur M1
    const m1 = body.data.find((m) => m.id_ffhb_match === "CAL-M-001")!;
    expect(m1.via_principal).toBe(true);
    expect(m1.via_entente).toBe(false);
  });

  it("includes entente matches when include_ententes=true (default)", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id_ffhb_match: string; via_entente: boolean }[];
      meta: { total: number; equipes_liees: { nom: string; is_entente: boolean }[] };
    };
    // M1 + M2 + M3 → 3 matchs
    expect(body.meta.total).toBe(3);
    const ids_matchs = body.data.map((m) => m.id_ffhb_match);
    expect(ids_matchs).toContain("CAL-M-003");
    // M3 doit avoir via_entente = true
    const m3 = body.data.find((m) => m.id_ffhb_match === "CAL-M-003")!;
    expect(m3.via_entente).toBe(true);
    // equipes_liees doit contenir l'entente
    const entente = body.meta.equipes_liees.find((e) => e.nom === "ENTENTE BREST PLOUDA");
    expect(entente).toBeDefined();
    expect(entente!.is_entente).toBe(true);
  });

  it("excludes entente matches when include_ententes=false", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026&include_ententes=false");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id_ffhb_match: string }[];
      meta: { total: number };
    };
    expect(body.meta.total).toBe(2);
    expect(body.data.map((m) => m.id_ffhb_match)).not.toContain("CAL-M-003");
  });

  it("filters by date_from", async () => {
    // M1 : 2025-10-01, M2 : 2025-10-08, M3 : 2025-11-01
    const res = await app.request(
      "/clubs/CAL-C001/matchs?saison=2025-2026&date_from=2025-10-05T00:00:00Z",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb_match: string }[]; meta: { total: number } };
    // M1 est avant date_from → exclu
    expect(body.data.map((m) => m.id_ffhb_match)).not.toContain("CAL-M-001");
    expect(body.data.map((m) => m.id_ffhb_match)).toContain("CAL-M-002");
  });

  it("filters by statut", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026&statut=a_jouer");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb_match: string; statut: string }[] };
    // Seul M3 est 'a_jouer' (entente incluse par défaut)
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id_ffhb_match).toBe("CAL-M-003");
    expect(body.data[0]!.statut).toBe("a_jouer");
  });

  it("returns 404 when club not found", async () => {
    const res = await app.request("/clubs/GHOST-CLUB/matchs?saison=2025-2026");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("meta.equipes_liees lists detected teams with correct flags", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: {
        club: { id_ffhb: string; nom: string };
        equipes_liees: { nom: string; is_principal: boolean; is_entente: boolean }[];
      };
    };
    expect(body.meta.club.id_ffhb).toBe("CAL-C001");
    expect(body.meta.club.nom).toBe("BREST BRETAGNE HANDBALL");
    const equipes = body.meta.equipes_liees;
    const principal = equipes.find((e) => e.nom === "BREST BRETAGNE HANDBALL");
    expect(principal).toBeDefined();
    expect(principal!.is_principal).toBe(true);
    expect(principal!.is_entente).toBe(false);
    const reserve = equipes.find((e) => e.nom === "BREST BRETAGNE HANDBALL 2");
    expect(reserve).toBeDefined();
    expect(reserve!.is_principal).toBe(false);
    const entente = equipes.find((e) => e.nom === "ENTENTE BREST PLOUDA");
    expect(entente).toBeDefined();
    expect(entente!.is_entente).toBe(true);
    // L'équipe non liée (PARIS 92) ne doit PAS apparaître
    expect(equipes.find((e) => e.nom === "PARIS 92")).toBeUndefined();
  });

  it("expose match_method et confidence sur les équipes liées", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: { equipes_liees: { nom: string; match_method: string; confidence: string }[] };
    };
    const principal = body.meta.equipes_liees.find((e) => e.nom === "BREST BRETAGNE HANDBALL")!;
    expect(principal.match_method).toBe("nom_exact");
    expect(principal.confidence).toBe("haute");
    const reserve = body.meta.equipes_liees.find((e) => e.nom === "BREST BRETAGNE HANDBALL 2")!;
    expect(reserve.match_method).toBe("nom_reserve");
    expect(reserve.confidence).toBe("moyenne");
  });

  it("ne lie pas une entente partageant seulement un mot générique (HANDBALL)", async () => {
    // Club au nom générique + entente sans token distinctif commun
    await query(
      `INSERT INTO core.clubs (id_ffhb, nom, last_seen_at)
       VALUES ('CAL-C003', 'ALPHACITY HANDBALL', now())
       ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
    );
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
       VALUES ('CAL-EQ-FP', 'ENTENTE HANDBALL BETAVILLE', '2025-2026', now())
       ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom`,
    );
    const res = await app.request("/clubs/CAL-C003/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { equipes_liees: { nom: string }[] } };
    expect(body.meta.equipes_liees.find((e) => e.nom === "ENTENTE HANDBALL BETAVILLE")).toBeUndefined();
  });

  it("min_confidence=haute exclut les réserves (moyenne)", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026&min_confidence=haute");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: { equipes_liees: { nom: string; confidence: string }[] };
    };
    expect(body.meta.equipes_liees.every((e) => e.confidence === "haute")).toBe(true);
    expect(body.meta.equipes_liees.find((e) => e.nom === "BREST BRETAGNE HANDBALL 2")).toBeUndefined();
  });

  it("returns 200 with empty data when club has no linked teams", async () => {
    // Club sans équipes correspondantes dans cette saison
    await query(
      `INSERT INTO core.clubs (id_ffhb, nom, ville, last_seen_at)
       VALUES ('CAL-C002', 'CLUB INEXISTANT XYZ', 'Nulle Part', now())
       ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
    );
    const res = await app.request("/clubs/CAL-C002/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      meta: { total: number; equipes_liees: unknown[] };
    };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(body.meta.equipes_liees).toHaveLength(0);
  });

  it("club_recevant is true when linked team is home team", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026&include_ententes=false");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id_ffhb_match: string; club_recevant: boolean }[];
    };
    const m1 = body.data.find((m) => m.id_ffhb_match === "CAL-M-001")!;
    // M1 : equipeMain est domicile → club_recevant = true
    expect(m1.club_recevant).toBe(true);
    const m2 = body.data.find((m) => m.id_ffhb_match === "CAL-M-002")!;
    // M2 : equipeReserve est visiteur → club_recevant = false
    expect(m2.club_recevant).toBe(false);
  });

  afterAll(async () => {
    await closePool();
  });
});
