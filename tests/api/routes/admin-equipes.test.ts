// Intégration : base de test requise (insère un club et des équipes de test, les supprime ensuite).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();
const SECRET = "test-admin-secret-0123456789";
const prevSecret = process.env.ADMIN_SECRET;
const SAISON = "2099-2100";
const CLUB = "TST-OVR-CLUB";
const IDS = ["TST-OVR-1", "TST-OVR-2"];
const h = { "content-type": "application/json", "x-admin-secret": SECRET };

const groupes = async () => {
  _resetBuckets();
  const r = await app.request(`/admin/clubs/${CLUB}/groupes?saison=${SAISON}`, { headers: h });
  expect(r.status).toBe(200);
  return (await r.json()).data as { groupes: Array<{ libelle: string; equipes: Array<{ id_ffhb: string }> }>; overrides: unknown[] };
};

beforeAll(async () => {
  process.env.ADMIN_SECRET = SECRET;
  await query(`INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1, '2099-07-01', '2100-06-30') ON CONFLICT DO NOTHING`, [SAISON]);
  await query(`INSERT INTO core.clubs (id_ffhb, nom, last_seen_at) VALUES ($1, 'Zorglub Handball', now()) ON CONFLICT (id_ffhb) DO NOTHING`, [CLUB]);
  await query(`DELETE FROM core.equipe_overrides WHERE equipe_id_ffhb = ANY($1)`, [IDS]);
  await query(`DELETE FROM core.equipes WHERE id_ffhb = ANY($1)`, [IDS]);
  await query(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, ext_structure_id) VALUES
       ($1, 'ZORGLUB HANDBALL SM', $3, $4), ($2, 'ZORGLUB HANDBALL SM', $3, $4)`,
    [IDS[0], IDS[1], SAISON, CLUB],
  );
});

afterAll(async () => {
  await query(`DELETE FROM core.equipe_overrides WHERE equipe_id_ffhb = ANY($1)`, [IDS]);
  await query(`DELETE FROM core.equipes WHERE id_ffhb = ANY($1)`, [IDS]);
  await query(`DELETE FROM core.clubs WHERE id_ffhb = $1`, [CLUB]);
  if (prevSecret === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = prevSecret;
  await closePool();
});

describe("corrections manuelles du regroupement", () => {
  it("401 sans secret", async () => {
    _resetBuckets();
    expect((await app.request("/admin/equipe-overrides")).status).toBe(401);
  });

  it("sans correction, deux inscriptions aux noms identiques forment une seule équipe", async () => {
    expect((await groupes()).groupes).toHaveLength(1);
  });

  it("PUT : forcer le rang 2 sépare les équipes, et l'API publique en tient compte", async () => {
    _resetBuckets();
    const put = await app.request(`/admin/equipe-overrides/${IDS[1]}`, { method: "PUT", headers: h, body: JSON.stringify({ rang: 2, note: "test" }) });
    expect(put.status).toBe(200);
    const g = await groupes();
    expect(g.groupes.map((x) => x.libelle)).toEqual(["Seniors M", "Seniors M (équipe 2)"]);
    expect(g.groupes[1]!.equipes.map((e) => e.id_ffhb)).toEqual([IDS[1]]);

    // L'API publique (clé API non requise en test ? on passe par le dépôt pour rester indépendant de l'auth)
    const { getOverrides } = await import("@/api/lib/repositories/equipe-overrides.repo.js");
    expect((await getOverrides(IDS)).get(IDS[1]!)?.rang).toBe(2);
  });

  it("exclu : l'inscription disparaît des groupes mais reste dans inscriptions", async () => {
    _resetBuckets();
    await app.request(`/admin/equipe-overrides/${IDS[1]}`, { method: "PUT", headers: h, body: JSON.stringify({ exclu: true }) });
    _resetBuckets();
    const r = await app.request(`/admin/clubs/${CLUB}/groupes?saison=${SAISON}`, { headers: h });
    const d = (await r.json()).data;
    expect(d.groupes.flatMap((x: { equipes: Array<{ id_ffhb: string }> }) => x.equipes.map((e) => e.id_ffhb))).toEqual([IDS[0]]);
    expect(d.inscriptions).toHaveLength(2);
  });

  it("DELETE supprime la correction (puis 404)", async () => {
    _resetBuckets();
    expect((await app.request(`/admin/equipe-overrides/${IDS[1]}`, { method: "DELETE", headers: h })).status).toBe(200);
    _resetBuckets();
    expect((await app.request(`/admin/equipe-overrides/${IDS[1]}`, { method: "DELETE", headers: h })).status).toBe(404);
    expect((await groupes()).groupes).toHaveLength(1);
  });

  it("validation : 400 si catégorie invalide, 404 si inscription inconnue", async () => {
    _resetBuckets();
    const bad = await app.request(`/admin/equipe-overrides/${IDS[0]}`, { method: "PUT", headers: h, body: JSON.stringify({ categorie: "-99" }) });
    expect(bad.status).toBe(400);
    _resetBuckets();
    const unknown = await app.request(`/admin/equipe-overrides/TST-INCONNU`, { method: "PUT", headers: h, body: JSON.stringify({ rang: 2 }) });
    expect(unknown.status).toBe(404);
  });
});
