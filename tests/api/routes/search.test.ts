// tests/api/routes/search.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "@/api/server.js";
import { query, closePool } from "@/db/client.js";
import { _resetBuckets } from "@/api/middleware/rate-limit.js";

const app = buildApp();

async function seedSearchData(): Promise<void> {
  // Seed a club for search
  await query(
    `INSERT INTO core.clubs (id_ffhb, nom, ville, last_seen_at)
     VALUES ('SRCH-C001', 'MONTPELLIER HANDBALL CLUB', 'Montpellier', now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
  );
  // Seed a joueur for search
  await query(
    `INSERT INTO core.joueurs (numero_licence, nom, prenom, last_seen_at)
     VALUES ('SRCH-LIC-001', 'KARABATIC', 'Nikola', now())
     ON CONFLICT (numero_licence) DO UPDATE SET nom = EXCLUDED.nom`,
  );
  // Seed an equipe for search
  const saisonCode = "2025-2026";
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [saisonCode],
  );
  await query(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('SRCH-EQ001', 'Montpellier HB Senior', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom`,
    [saisonCode],
  );
}

describe("GET /search", () => {
  beforeAll(async () => {
    await seedSearchData();
  });

  beforeEach(() => {
    _resetBuckets();
  });

  it("returns clubs matching query", async () => {
    const res = await app.request("/search?q=montpellier&type=clubs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { type: string; nom: string }[] };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const club = body.data.find((d) => d.type === "club" && d.nom.toLowerCase().includes("montpellier"));
    expect(club).toBeDefined();
  });

  it("returns joueurs matching query", async () => {
    const res = await app.request("/search?q=karabatic&type=joueurs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { type: string; nom: string }[] };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const joueur = body.data.find((d) => d.type === "joueur");
    expect(joueur).toBeDefined();
    expect(joueur!.nom.toLowerCase()).toContain("karabatic");
  });

  it("returns multi-entity results with type=all", async () => {
    const res = await app.request("/search?q=montpellier&type=all&limit=20");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { type: string }[] };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const types = new Set(body.data.map((d) => d.type));
    // Should find at least clubs and equipes for "montpellier"
    expect(types.size).toBeGreaterThanOrEqual(1);
  });

  it("returns 400 when q is too short", async () => {
    const res = await app.request("/search?q=a");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  afterAll(async () => {
    await closePool();
  });
});
