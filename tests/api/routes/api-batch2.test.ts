// tests/api/routes/api-batch2.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();
const SAISON = "2025-2026";
const CLUB_ID = "8800";
const CLUB_CODE = "5123456";
const LICENCE = "5123456100001";

beforeAll(async () => {
  await query(`DELETE FROM core.match_compositions WHERE joueur_id IN (SELECT id FROM core.joueurs WHERE numero_licence = $1)`, [LICENCE]);
  await query(`DELETE FROM core.match_officiels WHERE arbitre_id IN (SELECT id FROM core.arbitres WHERE id_ffhb = 'B2-ARB')`);
  await query(`DELETE FROM core.classements WHERE id_ffhb = 'B2-CL'`);
  await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'B2-M-%'`);
  await query(`DELETE FROM core.joueurs WHERE numero_licence = $1`, [LICENCE]);
  await query(`DELETE FROM core.arbitres WHERE id_ffhb = 'B2-ARB'`);
  await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'B2-EQ%' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.poules WHERE id_ffhb = 'B2-PO' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.phases WHERE id_ffhb = 'B2-PH' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.competitions WHERE id_ffhb = 'B2-COMP'`);
  await query(`DELETE FROM core.clubs WHERE id_ffhb = $1`, [CLUB_ID]);

  await query(`INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1,'2025-09-01','2026-06-30') ON CONFLICT (saison_code) DO NOTHING`, [SAISON]);
  await query(
    `INSERT INTO core.clubs (id_ffhb, nom, email, last_seen_at) VALUES ($1, 'CLUB B2', $2, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET email = EXCLUDED.email`,
    [CLUB_ID, `${CLUB_CODE}@ffhandball.net`],
  );
  const comp = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at) VALUES ('B2-COMP','Comp B2','national',$1,now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom=EXCLUDED.nom RETURNING id`, [SAISON]);
  const ph = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at) VALUES ('B2-PH',$1,'Ph',$2,now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom=EXCLUDED.nom RETURNING id`, [comp.rows[0]!.id, SAISON]);
  const po = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at) VALUES ('B2-PO',$1,'Po',$2,now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom=EXCLUDED.nom RETURNING id`, [ph.rows[0]!.id, SAISON]);
  const pouleId = po.rows[0]!.id;
  const eq1 = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, ext_structure_id, saison_code, last_seen_at) VALUES ('B2-EQ1','EQUIPE B2',$1,$2,now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET ext_structure_id=EXCLUDED.ext_structure_id RETURNING id`, [CLUB_ID, SAISON]);
  const adv = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at) VALUES ('B2-EQADV','ADV B2',$1,now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom=EXCLUDED.nom RETURNING id`, [SAISON]);
  const match = await query<{ id: bigint }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut, score_dom, score_ext)
     VALUES ('B2-M-001',$1,$2,$3,'2025-10-01T20:00:00Z','joue',30,25)
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut=EXCLUDED.statut RETURNING id`,
    [pouleId, eq1.rows[0]!.id, adv.rows[0]!.id]);
  const j = await query<{ id: bigint }>(
    `INSERT INTO core.joueurs (numero_licence, nom, prenom) VALUES ($1,'STAR','Player')
     ON CONFLICT (numero_licence) DO UPDATE SET nom=EXCLUDED.nom RETURNING id`, [LICENCE]);
  await query(
    `INSERT INTO core.match_compositions (match_id, joueur_id, equipe_id, but_count) VALUES ($1,$2,$3,7)
     ON CONFLICT (match_id, joueur_id) DO NOTHING`,
    [match.rows[0]!.id, j.rows[0]!.id, eq1.rows[0]!.id]);
  await query(
    `INSERT INTO core.classements (id_ffhb, poule_id, equipe_id, position, points, joues, gagnes, nuls, perdus, buts_pour, buts_contre, capture_date)
     VALUES ('B2-CL',$1,$2,1,3,1,1,0,0,30,25,now()) ON CONFLICT DO NOTHING`,
    [pouleId, eq1.rows[0]!.id]);
  const arb = await query<{ id: bigint }>(
    `INSERT INTO core.arbitres (id_ffhb, numero_licence, nom, prenom, nom_complet, niveau, last_seen_at)
     VALUES ('B2-ARB','7654321','MARTIN','Paul','MARTIN Paul','national',now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom=EXCLUDED.nom RETURNING id`);
  await query(`INSERT INTO core.match_officiels (match_id, arbitre_id, role) VALUES ($1,$2,'arbitre_1') ON CONFLICT DO NOTHING`,
    [match.rows[0]!.id, arb.rows[0]!.id]);
});

describe("référentiels", () => {
  it("/saisons liste la saison courante", async () => {
    _resetBuckets();
    const res = await app.request("/saisons");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { saison_code: string }[] };
    expect(body.data.map((s) => s.saison_code)).toContain("2025-2026");
  });
  it("/departements et /ligues répondent 200", async () => {
    _resetBuckets();
    expect((await app.request("/departements")).status).toBe(200);
    expect((await app.request("/ligues")).status).toBe(200);
  });
});

describe("effectifs", () => {
  it("/equipes/:id/joueurs liste l'effectif avec buts", async () => {
    _resetBuckets();
    const res = await app.request("/equipes/B2-EQ1/joueurs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { numero_licence: string; buts: number }[] };
    const star = body.data.find((j) => j.numero_licence === LICENCE);
    expect(star).toBeDefined();
    expect(star!.buts).toBe(7);
  });
  it("/clubs/:id/joueurs par id_club ET par code_ffhb", async () => {
    _resetBuckets();
    const byId = await app.request(`/clubs/${CLUB_ID}/joueurs`);
    expect(byId.status).toBe(200);
    const b1 = (await byId.json()) as { data: { numero_licence: string }[] };
    expect(b1.data.map((j) => j.numero_licence)).toContain(LICENCE);
    const byCode = await app.request(`/clubs/${CLUB_CODE}/joueurs`);
    const b2 = (await byCode.json()) as { data: { numero_licence: string }[] };
    expect(b2.data.map((j) => j.numero_licence)).toContain(LICENCE);
  });
  it("/clubs/:id/classements liste les positions des équipes", async () => {
    _resetBuckets();
    const res = await app.request(`/clubs/${CLUB_ID}/classements?saison=2025-2026`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { equipe: { id_ffhb: string }; position: number }[] };
    const eq = body.data.find((x) => x.equipe.id_ffhb === "B2-EQ1");
    expect(eq).toBeDefined();
    expect(eq!.position).toBe(1);
  });
});

describe("joueur & arbitre approfondis", () => {
  it("/joueurs/:licence/matchs retourne l'historique", async () => {
    _resetBuckets();
    const res = await app.request(`/joueurs/${LICENCE}/matchs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb_match: string; buts: number }[]; meta: { total: number } };
    const m = body.data.find((x) => x.id_ffhb_match === "B2-M-001");
    expect(m).toBeDefined();
    expect(m!.buts).toBe(7);
  });
  it("/joueurs/:licence/matchs 404 si inconnu", async () => {
    _resetBuckets();
    expect((await app.request("/joueurs/0000000000/matchs")).status).toBe(404);
  });
  it("/arbitres/:id_ffhb détail avec nb_matchs", async () => {
    _resetBuckets();
    const res = await app.request("/arbitres/B2-ARB");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb: string; nb_matchs: number } };
    expect(body.data.id_ffhb).toBe("B2-ARB");
    expect(body.data.nb_matchs).toBeGreaterThanOrEqual(1);
  });
  it("/arbitres/:id_ffhb 404 si inconnu", async () => {
    _resetBuckets();
    expect((await app.request("/arbitres/GHOST")).status).toBe(404);
  });

  afterAll(async () => {
    await closePool();
  });
});
