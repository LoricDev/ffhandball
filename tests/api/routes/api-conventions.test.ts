// tests/api/routes/api-conventions.test.ts — conventions transverses de l'API (erreurs, validation, filtres, spec).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp({ authEnabled: false });

interface ErrBody { error: { code: string; message: string; request_id?: string } }
interface ListBody { data: Array<Record<string, any>>; meta: { total: number; limit: number; offset: number } } // eslint-disable-line @typescript-eslint/no-explicit-any

const SAISON = "2025-2026";
const POULE = "PO-CONV";
let pouleId: bigint;

beforeAll(async () => {
  await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'M-CONV-%'`);
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1,'2025-09-01','2026-06-30') ON CONFLICT DO NOTHING`,
    [SAISON],
  );
  const c = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at) VALUES ('COMP-CONV','Comp Conv','national',$1,now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const ph = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at) VALUES ('PH-CONV',$1,'Phase Conv',$2,now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [c.rows[0]!.id, SAISON],
  );
  const po = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at) VALUES ($1,$2,'Poule Conv',$3,now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [POULE, ph.rows[0]!.id, SAISON],
  );
  pouleId = po.rows[0]!.id;
  const eq = async (id: string, nom: string) =>
    (await query<{ id: bigint }>(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
      [id, nom, SAISON],
    )).rows[0]!.id;
  const a = await eq("EQ-CONV-A", "Conv A");
  const b = await eq("EQ-CONV-B", "Conv B");
  // 3 matchs à la MÊME heure : le tri doit rester déterministe (départage par id).
  for (const [i, j] of [[1, 1], [2, 1], [3, 2]] as const) {
    await query(
      `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut, journee)
       VALUES ($1,$2,$3,$4,'2026-01-10T18:00:00Z','a_jouer',$5)
       ON CONFLICT (id_ffhb_match) DO NOTHING`,
      [`M-CONV-00${i}`, pouleId, a, b, j],
    );
  }
});

beforeEach(() => _resetBuckets());
afterAll(async () => {
  await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'M-CONV-%'`);
  await closePool();
});

describe("erreurs", () => {
  it("route inconnue : 404 au format { error }", async () => {
    const res = await app.request("/nimporte-quoi");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrBody).error.code).toBe("NOT_FOUND");
  });

  it("une exception interne ne fuite pas son message et expose un request_id", async () => {
    const a = buildApp({ authEnabled: false });
    a.get("/__boom", () => {
      throw new Error('relation "core.secret" does not exist');
    });
    const res = await a.request("/__boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrBody;
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("X-Request-Id entrant sobre est repris, un identifiant douteux est remplacé", async () => {
    const ok = await app.request("/health", { headers: { "x-request-id": "trace-abc-12345" } });
    expect(ok.headers.get("x-request-id")).toBe("trace-abc-12345");
    const bad = await app.request("/health", { headers: { "x-request-id": "x y z !" } });
    expect(bad.headers.get("x-request-id")).not.toBe("x y z !");
  });

  it("validation d'un sous-routeur : enveloppe { error: BAD_REQUEST }", async () => {
    const res = await app.request("/classements");
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrBody).error.code).toBe("BAD_REQUEST");
  });

  it("date invalide : 400 (et non une erreur SQL en 500)", async () => {
    for (const url of ["/matchs?date_from=pas-une-date", "/salles/x/matchs?date_to=zzz", "/equipes/x/matchs?date_from=hier"]) {
      expect((await app.request(url)).status, url).toBe(400);
    }
  });
});

describe("/matchs : filtres et tri", () => {
  const q = async (qs: string) => (await (await app.request(`/matchs?${qs}`)).json()) as ListBody;

  it("pagination déterministe malgré des heures identiques", async () => {
    const ids: string[] = [];
    for (const offset of [0, 1, 2]) {
      ids.push((await q(`poule_id_ffhb=${POULE}&limit=1&offset=${offset}&tri=date_asc`)).data[0]!.id_ffhb_match as string);
    }
    expect(ids).toEqual(["M-CONV-001", "M-CONV-002", "M-CONV-003"]);
  });

  it("tri date_desc inverse l'ordre ; meta.total est correct, y compris au-delà de la fin", async () => {
    const desc = await q(`poule_id_ffhb=${POULE}&tri=date_desc`);
    expect(desc.data.map((m) => m.id_ffhb_match)).toEqual(["M-CONV-003", "M-CONV-002", "M-CONV-001"]);
    const beyond = await q(`poule_id_ffhb=${POULE}&offset=50`);
    expect(beyond.data).toEqual([]);
    expect(beyond.meta.total).toBe(3);
  });

  it("filtres equipe, competition, journee", async () => {
    expect((await q("equipe_id_ffhb=EQ-CONV-A")).meta.total).toBe(3);
    expect((await q("equipe_id_ffhb=EQ-CONV-B&journee=2")).data.map((m) => m.id_ffhb_match)).toEqual(["M-CONV-003"]);
    expect((await q("competition_id_ffhb=COMP-CONV&journee=1")).meta.total).toBe(2);
    expect((await q("competition_id_ffhb=INCONNUE")).meta.total).toBe(0);
  });

  it("expose les identifiants des équipes", async () => {
    const body = await q(`poule_id_ffhb=${POULE}&limit=1`);
    expect(body.data[0]).toMatchObject({ equipe_dom_id_ffhb: "EQ-CONV-A", equipe_ext_id_ffhb: "EQ-CONV-B" });
  });

  it("/equipes/:id/matchs accepte journee et tri", async () => {
    const res = await app.request(`/equipes/EQ-CONV-A/matchs?saison=${SAISON}&journee=1&tri=date_desc`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ListBody).meta.total).toBe(2);
  });
});

describe("/poules/:id/matchs", () => {
  it("liste les matchs de la poule avec pagination", async () => {
    const res = await app.request(`/poules/${POULE}/matchs?limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data).toHaveLength(2);
    expect(body.meta).toMatchObject({ total: 3, limit: 2, offset: 0 });
  });

  it("404 pour une poule inconnue", async () => {
    expect((await app.request("/poules/INCONNUE/matchs")).status).toBe(404);
  });
});

describe("cache et spec", () => {
  it("référentiels : cache d'une heure", async () => {
    const res = await app.request("/saisons");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("la spec déclare 429/500 partout, 400 sur les routes à paramètres, et le nouvel endpoint", async () => {
    const spec = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const get = spec.paths["/matchs"].get;
    expect(get.responses["429"]).toBeDefined();
    expect(get.responses["500"]).toBeDefined();
    expect(get.responses["400"]).toBeDefined();
    expect(get.responses["200"].headers["X-RateLimit-Limit"]).toBeDefined();
    expect(spec.paths["/poules/{id_ffhb}/matchs"]).toBeDefined();
    expect(spec.paths["/health"].get.responses["400"]).toBeUndefined();
  });
});
