// tests/api/routes/equipes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();
const SAISON = "2025-2026";
const CLUB_ID = "9001"; // id_club monclub
const CLUB_CODE = "5990001"; // code FFHB 7 chiffres (via email)

let pouleId: bigint;
let eqMainId: bigint;
let advId: bigint;

beforeAll(async () => {
  await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'EQT2-M-%'`);
  await query(`DELETE FROM core.engagements WHERE equipe_id IN (SELECT id FROM core.equipes WHERE id_ffhb LIKE 'EQT2-%' AND saison_code = $1)`, [SAISON]);
  await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'EQT2-%' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.poules WHERE id_ffhb = 'EQT2-PO' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.phases WHERE id_ffhb = 'EQT2-PH' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.competitions WHERE id_ffhb = 'EQT2-COMP'`);
  await query(`DELETE FROM core.clubs WHERE id_ffhb = $1`, [CLUB_ID]);

  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30') ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
  await query(
    `INSERT INTO core.clubs (id_ffhb, nom, email, last_seen_at)
     VALUES ($1, 'CLUB TEST T2', $2, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET email = EXCLUDED.email`,
    [CLUB_ID, `${CLUB_CODE}@ffhandball.net`],
  );
  const comp = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('EQT2-COMP', 'Comp T2', 'regional', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const ph = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('EQT2-PH', $1, 'Phase', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const po = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ('EQT2-PO', $1, 'Poule', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [ph.rows[0]!.id, SAISON],
  );
  pouleId = po.rows[0]!.id;
  // Équipe propre du club : ext_structure_id = id_club du club
  const main = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, ext_structure_id, saison_code, last_seen_at)
     VALUES ('EQT2-EQ1', 'CLUB TEST T2', $1, $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET ext_structure_id = EXCLUDED.ext_structure_id RETURNING id`,
    [CLUB_ID, SAISON],
  );
  eqMainId = main.rows[0]!.id;
  const adv = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('EQT2-ADV', 'ADVERSAIRE T2', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  advId = adv.rows[0]!.id;
  await query(`INSERT INTO core.engagements (equipe_id, poule_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [eqMainId, pouleId]);
  await query(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut)
     VALUES ('EQT2-M-001', $1, $2, $3, '2025-10-01T20:00:00Z', 'joue')
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut`,
    [pouleId, eqMainId, advId],
  );
});

describe("GET /equipes/:id_ffhb", () => {
  it("retourne club (via pont ext_structure_id) + engagements", async () => {
    _resetBuckets();
    const res = await app.request("/equipes/EQT2-EQ1?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id_ffhb: string;
        club: { id_ffhb: string; code_ffhb: string | null } | null;
        engagements: { poule: { id_ffhb: string }; competition: { id_ffhb: string } }[];
      };
    };
    expect(body.data.id_ffhb).toBe("EQT2-EQ1");
    expect(body.data.club).not.toBeNull();
    expect(body.data.club!.id_ffhb).toBe(CLUB_ID);
    expect(body.data.club!.code_ffhb).toBe(CLUB_CODE);
    expect(body.data.engagements.map((e) => e.poule.id_ffhb)).toContain("EQT2-PO");
  });

  it("404 si équipe inconnue", async () => {
    _resetBuckets();
    const res = await app.request("/equipes/GHOST?saison=2025-2026");
    expect(res.status).toBe(404);
  });
});

describe("GET /equipes/:id_ffhb/matchs", () => {
  it("retourne les matchs de l'équipe", async () => {
    _resetBuckets();
    const res = await app.request("/equipes/EQT2-EQ1/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb_match: string }[]; meta: { total: number } };
    expect(body.data.map((m) => m.id_ffhb_match)).toContain("EQT2-M-001");
  });
});

describe("GET /clubs/:id_ffhb/equipes", () => {
  it("liste les équipes propres du club via le pont (par id_club OU code_ffhb)", async () => {
    _resetBuckets();
    const byId = await app.request(`/clubs/${CLUB_ID}/equipes?saison=2025-2026`);
    expect(byId.status).toBe(200);
    const b1 = (await byId.json()) as { data: { id_ffhb: string }[]; meta: { club: { code_ffhb: string | null } } };
    expect(b1.data.map((e) => e.id_ffhb)).toContain("EQT2-EQ1");
    expect(b1.meta.club.code_ffhb).toBe(CLUB_CODE);
    // résolution par code FFHB 7 chiffres
    const byCode = await app.request(`/clubs/${CLUB_CODE}/equipes?saison=2025-2026`);
    expect(byCode.status).toBe(200);
    const b2 = (await byCode.json()) as { data: { id_ffhb: string }[] };
    expect(b2.data.map((e) => e.id_ffhb)).toContain("EQT2-EQ1");
  });

  afterAll(async () => {
    await closePool();
  });
});
