import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { currentSaison } from "@/lib/saison.js";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

describe("currentSaison", () => {
  it("bascule le 1er juillet (UTC)", () => {
    expect(currentSaison(new Date("2026-06-30T23:59:59Z"))).toBe("2025-2026");
    expect(currentSaison(new Date("2026-07-01T00:00:00Z"))).toBe("2026-2027");
    expect(currentSaison(new Date("2026-10-15T12:00:00Z"))).toBe("2026-2027");
    expect(currentSaison(new Date("2027-01-02T12:00:00Z"))).toBe("2026-2027");
    expect(currentSaison(new Date("2027-06-30T12:00:00Z"))).toBe("2026-2027");
  });
});

// Intégration : base de test requise (insère des saisons/compétitions de test, les supprime ensuite).
describe("saison par défaut et filtre /matchs", () => {
  const app = buildApp({ authEnabled: false });
  const now = currentSaison();
  const prevYear = Number(now.slice(0, 4)) - 1;
  const previous = `${prevYear}-${prevYear + 1}`;
  const ids = ["TST-SAISON-CUR", "TST-SAISON-PREV"];

  beforeAll(async () => {
    for (const s of [now, previous]) {
      const y = Number(s.slice(0, 4));
      await query(
        `INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [s, `${y}-07-01`, `${y + 1}-06-30`],
      );
    }
    await query(`DELETE FROM core.competitions WHERE id_ffhb = ANY($1)`, [ids]);
    await query(
      `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code) VALUES ($1, 'COMP SAISON COURANTE', 'departemental', $2), ($3, 'COMP SAISON PRECEDENTE', 'departemental', $4)`,
      [ids[0], now, ids[1], previous],
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM core.competitions WHERE id_ffhb = ANY($1)`, [ids]);
    await closePool();
  });

  it("/competitions sans saison renvoie la saison COURANTE et l'indique dans meta.saison", async () => {
    _resetBuckets();
    const res = await app.request("/v1/competitions?q=COMP SAISON&limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id_ffhb: string; saison_code: string }>; meta: { saison: string } };
    expect(body.meta.saison).toBe(now);
    const found = body.data.map((c) => c.id_ffhb);
    expect(found).toContain(ids[0]);
    expect(found).not.toContain(ids[1]);
  });

  it("/competitions?saison=… reste honoré", async () => {
    _resetBuckets();
    const res = await app.request(`/v1/competitions?q=COMP SAISON&saison=${previous}&limit=50`);
    const body = (await res.json()) as { data: Array<{ id_ffhb: string }>; meta: { saison: string } };
    expect(body.meta.saison).toBe(previous);
    expect(body.data.map((c) => c.id_ffhb)).toContain(ids[1]);
  });

  it("/matchs : meta.saison = null sans filtre, = la saison avec le filtre ; format invalide refusé", async () => {
    _resetBuckets();
    const all = (await (await app.request("/v1/matchs?limit=1")).json()) as { meta: { saison: string | null } };
    expect(all.meta.saison).toBeNull();
    const filtered = (await (await app.request(`/v1/matchs?limit=1&saison=${now}`)).json()) as { meta: { saison: string | null } };
    expect(filtered.meta.saison).toBe(now);
    expect((await app.request("/v1/matchs?saison=2026")).status).toBe(400);
  });

  it("/search indique la saison utilisée", async () => {
    _resetBuckets();
    const res = await app.request("/v1/search?q=handball");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { meta: { saison: string } }).meta.saison).toBe(now);
  });
});
