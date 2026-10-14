// ATTENTION : ce test TRUNCATE les tables core (comme les autres tests d'intégration) : base de TEST uniquement.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { deliverDue } from "@/webhooks/deliver.js";
import { verifySignature } from "@/webhooks/signing.js";

const SAISON = "2099-2100";
const publicResolver = async () => [{ address: "93.184.216.34" }];

let matchId: string;

async function addSub(url: string, club?: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO core.webhook_subscriptions (url, secret, club_id_ffhb) VALUES ($1, 'whsec_test', $2) RETURNING id`,
    [url, club ?? null],
  );
  return r.rows[0]!.id;
}

async function playMatch(scoreDom: number | null, scoreExt: number | null, statut: string, forfait: string | null = null) {
  await query(`UPDATE core.matchs SET score_dom = $2, score_ext = $3, statut = $4, forfait_equipe = $5 WHERE id = $1`, [
    matchId,
    scoreDom,
    scoreExt,
    statut,
    forfait,
  ]);
}

const fetchWith = (status: number, onCall?: (url: string, init: RequestInit) => void) =>
  (async (url: string, init: RequestInit) => {
    onCall?.(url, init);
    return new Response(status === 204 ? null : "x", { status });
  }) as unknown as typeof fetch;

beforeEach(async () => {
  await query(
    `TRUNCATE core.webhook_deliveries, core.webhook_subscriptions, core.match_events, core.matchs, core.engagements,
              core.equipes, core.poules, core.phases, core.competitions RESTART IDENTITY CASCADE`,
  );
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1, '2099-07-01', '2100-06-30') ON CONFLICT DO NOTHING`,
    [SAISON],
  );
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code) VALUES ('C1', 'COUPE TEST', 'departemental', $1) RETURNING id`,
    [SAISON],
  );
  const phase = await query<{ id: number }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code) VALUES ('PH1', $1, 'P', $2) RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const poule = await query<{ id: number }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code) VALUES ('PO1', $1, 'POULE A', $2) RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const dom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, ext_structure_id) VALUES ('E1', 'DOMICILE HB', $1, 'CLUB_DOM') RETURNING id`,
    [SAISON],
  );
  const ext = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, ext_structure_id) VALUES ('E2', 'EXTERIEUR HB', $1, 'CLUB_EXT') RETURNING id`,
    [SAISON],
  );
  const m = await query<{ id: string }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut)
     VALUES ('M1', $1, $2, $3, now() - interval '1 day', 'a_jouer') RETURNING id`,
    [poule.rows[0]!.id, dom.rows[0]!.id, ext.rows[0]!.id],
  );
  matchId = m.rows[0]!.id;
});

afterAll(async () => {
  await closePool();
});

describe("webhooks : trigger", () => {
  it("aucun abonné actif : aucun événement stocké", async () => {
    await playMatch(30, 25, "joue");
    expect((await query(`SELECT 1 FROM core.match_events`)).rowCount).toBe(0);
  });

  it("résultat : 1 événement et 1 livraison pour chaque abonné actif", async () => {
    await addSub("https://example.org/a");
    await addSub("https://example.org/b");
    await playMatch(30, 25, "joue");
    const e = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM core.match_events WHERE event = 'match.result'`,
    );
    expect(e.rowCount).toBe(1);
    expect(e.rows[0]!.payload).toMatchObject({
      id_ffhb_match: "M1",
      statut: "joue",
      score_dom: 30,
      score_ext: 25,
      equipe_dom: { nom: "DOMICILE HB" },
      competition_nom: "COUPE TEST",
      saison: SAISON,
    });
    expect((await query(`SELECT 1 FROM core.webhook_deliveries WHERE status = 'pending'`)).rowCount).toBe(2);
  });

  it("un abonné désactivé ne reçoit rien", async () => {
    const id = await addSub("https://example.org/a");
    await query(`UPDATE core.webhook_subscriptions SET active = false WHERE id = $1`, [id]);
    await addSub("https://example.org/b");
    await playMatch(30, 25, "joue");
    expect((await query(`SELECT 1 FROM core.webhook_deliveries`)).rowCount).toBe(1);
  });

  it("filtre club : seulement les matchs d'une équipe du club", async () => {
    await addSub("https://example.org/dom", "CLUB_DOM");
    await addSub("https://example.org/autre", "CLUB_AUTRE");
    await playMatch(30, 25, "joue");
    const d = await query<{ url: string }>(
      `SELECT s.url FROM core.webhook_deliveries d JOIN core.webhook_subscriptions s ON s.id = d.subscription_id`,
    );
    expect(d.rows.map((r) => r.url)).toEqual(["https://example.org/dom"]);
  });

  it("forfait : événement avec forfait_equipe ; une mise à jour identique n'en crée pas", async () => {
    await addSub("https://example.org/a");
    await playMatch(null, 20, "forfait", "dom");
    expect((await query(`SELECT 1 FROM core.match_events`)).rowCount).toBe(1);
    await playMatch(null, 20, "forfait", "dom");
    expect((await query(`SELECT 1 FROM core.match_events`)).rowCount).toBe(1);
    const e = await query<{ payload: Record<string, unknown> }>(`SELECT payload FROM core.match_events`);
    expect(e.rows[0]!.payload).toMatchObject({ statut: "forfait", forfait_equipe: "dom", score_ext: 20 });
  });

  it("un match reporté ne déclenche rien", async () => {
    await addSub("https://example.org/a");
    await query(`UPDATE core.matchs SET statut = 'reporte' WHERE id = $1`, [matchId]);
    expect((await query(`SELECT 1 FROM core.match_events`)).rowCount).toBe(0);
  });
});

describe("webhooks : livraison", () => {
  it("POST signé, marqué livré sur 2xx", async () => {
    await addSub("https://example.org/a");
    await playMatch(30, 25, "joue");

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const r = await deliverDue({
      fetchImpl: fetchWith(200, (url, init) => calls.push({ url, init })),
      resolver: publicResolver,
    });
    expect(r).toMatchObject({ due: 1, delivered: 1, retried: 0, failed: 0 });
    expect(calls).toHaveLength(1);

    const headers = calls[0]!.init.headers as Record<string, string>;
    const body = calls[0]!.init.body as string;
    expect(JSON.parse(body)).toMatchObject({ type: "match.result", data: { id_ffhb_match: "M1" } });
    expect(
      verifySignature("whsec_test", Number(headers["x-webhook-timestamp"]), body, headers["x-webhook-signature"]!),
    ).toBe(true);

    const d = await query<{ status: string; attempts: number }>(`SELECT status, attempts FROM core.webhook_deliveries`);
    expect(d.rows[0]).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("échec HTTP : reprise planifiée ; un succès ensuite remet le compteur d'échecs à 0", async () => {
    const sub = await addSub("https://example.org/a");
    await playMatch(30, 25, "joue");

    const r1 = await deliverDue({ fetchImpl: fetchWith(500), resolver: publicResolver });
    expect(r1).toMatchObject({ due: 1, delivered: 0, retried: 1 });
    const d1 = await query<{ attempts: number; status: string; last_status: number; later: boolean }>(
      `SELECT attempts, status, last_status, next_attempt_at > now() AS later FROM core.webhook_deliveries`,
    );
    expect(d1.rows[0]).toMatchObject({ attempts: 1, status: "pending", last_status: 500, later: true });
    const f1 = await query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM core.webhook_subscriptions WHERE id = $1`,
      [sub],
    );
    expect(f1.rows[0]!.consecutive_failures).toBe(1);

    // Pas encore dû : rien à faire.
    expect((await deliverDue({ fetchImpl: fetchWith(500), resolver: publicResolver })).due).toBe(0);

    // On force l'échéance puis on réussit.
    await query(`UPDATE core.webhook_deliveries SET next_attempt_at = now() - interval '1 second'`);
    const r2 = await deliverDue({ fetchImpl: fetchWith(204), resolver: publicResolver });
    expect(r2.delivered).toBe(1);
    const f2 = await query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM core.webhook_subscriptions WHERE id = $1`,
      [sub],
    );
    expect(f2.rows[0]!.consecutive_failures).toBe(0);
  });

  it("URL résolvant vers une IP privée : jamais appelée (SSRF)", async () => {
    await addSub("https://evil.example/a");
    await playMatch(30, 25, "joue");
    let called = false;
    const r = await deliverDue({
      fetchImpl: fetchWith(200, () => {
        called = true;
      }),
      resolver: async () => [{ address: "169.254.169.254" }],
    });
    expect(called).toBe(false);
    expect(r.retried).toBe(1);
  });

  it("abandon après 7 tentatives", async () => {
    await addSub("https://example.org/a");
    await playMatch(30, 25, "joue");
    await query(`UPDATE core.webhook_deliveries SET attempts = 6`);
    const r = await deliverDue({ fetchImpl: fetchWith(500), resolver: publicResolver });
    expect(r.failed).toBe(1);
    const d = await query<{ status: string }>(`SELECT status FROM core.webhook_deliveries`);
    expect(d.rows[0]!.status).toBe("failed");
  });
});
