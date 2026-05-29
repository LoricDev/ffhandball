// tests/api/routes/api-batch-tier3.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();
const SAISON = "2025-2026";

beforeAll(async () => {
  await query(`DELETE FROM core.match_officiels WHERE arbitre_id IN (SELECT id FROM core.arbitres WHERE id_ffhb = 'T3-ARB')`);
  await query(`DELETE FROM core.stats_joueurs WHERE individu_id LIKE 'T3-IND-%'`);
  await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'T3-M-%'`);
  await query(`DELETE FROM core.arbitres WHERE id_ffhb = 'T3-ARB'`);
  await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'T3-EQ%' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.poules WHERE id_ffhb = 'T3-PO' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.phases WHERE id_ffhb = 'T3-PH' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.competitions WHERE id_ffhb = 'T3-COMP'`);
  await query(`DELETE FROM core.salles WHERE id_ffhb = 'T3-SALLE'`);

  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30') ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
  const comp = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('T3-COMP', 'Comp T3', 'national', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const ph = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('T3-PH', $1, 'Ph', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const po = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ('T3-PO', $1, 'Po', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [ph.rows[0]!.id, SAISON],
  );
  const pouleId = po.rows[0]!.id;
  const salle = await query<{ id: bigint }>(
    `INSERT INTO core.salles (id_ffhb, nom, ville, last_seen_at)
     VALUES ('T3-SALLE', 'GYMNASE TEST T3', 'Testville', now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
  );
  const salleId = salle.rows[0]!.id;
  const eq1 = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('T3-EQ1', 'EQUIPE T3 UN', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const eq2 = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('T3-EQ2', 'EQUIPE T3 DEUX', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const match = await query<{ id: bigint }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, salle_id, date_heure, statut)
     VALUES ('T3-M-001', $1, $2, $3, $4, '2025-10-01T20:00:00Z', 'joue')
     ON CONFLICT (id_ffhb_match) DO UPDATE SET salle_id = EXCLUDED.salle_id RETURNING id`,
    [pouleId, eq1.rows[0]!.id, eq2.rows[0]!.id, salleId],
  );
  const arb = await query<{ id: bigint }>(
    `INSERT INTO core.arbitres (id_ffhb, numero_licence, nom, prenom, nom_complet, niveau, last_seen_at)
     VALUES ('T3-ARB', '9990001', 'DUPONT', 'Jean', 'DUPONT Jean', 'régional', now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
  );
  await query(
    `INSERT INTO core.match_officiels (match_id, arbitre_id, role) VALUES ($1, $2, 'arbitre_1')
     ON CONFLICT DO NOTHING`,
    [match.rows[0]!.id, arb.rows[0]!.id],
  );
  // Stats joueurs (2 joueurs, snapshot unique)
  await query(
    `INSERT INTO core.stats_joueurs (poule_id, individu_id, nom, prenom, equipe_libelle, match_count, total_buts, total_arrets, saison_code, capture_date)
     VALUES ($1, 'T3-IND-1', 'BUTEUR', 'Top', 'EQUIPE T3 UN', 5, 42, 0, $2, now()),
            ($1, 'T3-IND-2', 'MILIEU', 'Bof', 'EQUIPE T3 UN', 5, 10, 0, $2, now())`,
    [pouleId, SAISON],
  );
});

describe("GET /stats-joueurs", () => {
  it("retourne les buteurs ordonnés par buts décroissants", async () => {
    _resetBuckets();
    const res = await app.request("/stats-joueurs?poule_id_ffhb=T3-PO");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { nom: string; total_buts: number }[]; meta: { total: number } };
    expect(body.meta.total).toBe(2);
    expect(body.data[0]!.nom).toBe("BUTEUR");
    expect(body.data[0]!.total_buts).toBe(42);
  });
  it("400 si poule_id_ffhb manquant", async () => {
    _resetBuckets();
    expect((await app.request("/stats-joueurs")).status).toBe(400);
  });
  it("404 si poule sans stats", async () => {
    _resetBuckets();
    expect((await app.request("/stats-joueurs?poule_id_ffhb=GHOST")).status).toBe(404);
  });
});

describe("GET /arbitres", () => {
  it("liste et recherche floue", async () => {
    _resetBuckets();
    const res = await app.request("/arbitres?q=DUPONT&limit=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb: string | null }[] };
    expect(body.data.find((a) => a.id_ffhb === "T3-ARB")).toBeDefined();
  });
  it("/arbitres/:id_ffhb/matchs retourne les matchs arbitrés", async () => {
    _resetBuckets();
    const res = await app.request("/arbitres/T3-ARB/matchs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb_match: string; role: string }[] };
    const m = body.data.find((x) => x.id_ffhb_match === "T3-M-001");
    expect(m).toBeDefined();
    expect(m!.role).toBe("arbitre_1");
  });
  it("404 si arbitre inconnu", async () => {
    _resetBuckets();
    expect((await app.request("/arbitres/GHOST/matchs")).status).toBe(404);
  });
});

describe("GET /salles", () => {
  it("/salles/:id_ffhb détail", async () => {
    _resetBuckets();
    const res = await app.request("/salles/T3-SALLE");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb: string; nom: string } };
    expect(body.data.id_ffhb).toBe("T3-SALLE");
    expect(body.data.nom).toBe("GYMNASE TEST T3");
  });
  it("/salles/:id_ffhb/matchs retourne les matchs accueillis", async () => {
    _resetBuckets();
    const res = await app.request("/salles/T3-SALLE/matchs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id_ffhb_match: string }[] };
    expect(body.data.map((m) => m.id_ffhb_match)).toContain("T3-M-001");
  });
  it("404 si salle inconnue", async () => {
    _resetBuckets();
    expect((await app.request("/salles/GHOST")).status).toBe(404);
  });

  afterAll(async () => {
    await closePool();
  });
});
