// Intégration : base de test requise (insère des équipes de test, les supprime ensuite).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { listClubEquipesAvecPartenaires } from "@/api/lib/repositories/equipe.repo.js";

const SAISON = "2099-2100";
const CLUB = { id_ffhb: "TST-CLUB-A", code_ffhb: null, nom: "Zorglub Handball" };
const IDS = ["TST-EQ-PORTEUR", "TST-EQ-ENTENTE-PARTENAIRE", "TST-EQ-AUTRE"];

describe("listClubEquipesAvecPartenaires", () => {
  beforeAll(async () => {
    await query(`INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES ($1, '2099-07-01', '2100-06-30') ON CONFLICT DO NOTHING`, [SAISON]);
    await query(`DELETE FROM core.equipes WHERE id_ffhb = ANY($1)`, [IDS]);
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code, ext_structure_id) VALUES
         ($1, 'ZORGLUB HANDBALL', $4, 'TST-CLUB-A'),
         ($2, 'ENTENTE AUTRECLUB/ZORGLUB SM', $4, 'TST-CLUB-B'),
         ($3, 'ENTENTE AUTRECLUB/TRUCMUCHE SM', $4, 'TST-CLUB-B')`,
      [IDS[0], IDS[1], IDS[2], SAISON],
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM core.equipes WHERE id_ffhb = ANY($1)`, [IDS]);
    await closePool();
  });

  it("inclut l'entente dont le club est PARTENAIRE (rattachée à un autre club côté FFHB), avec son lien", async () => {
    const r = await listClubEquipesAvecPartenaires(CLUB, SAISON, { include_ententes: true });
    const byId = new Map(r.map((e) => [e.id_ffhb, e]));
    expect(byId.get(IDS[0]!)?.lien).toEqual({ methode: "structure", confiance: "haute" });
    expect(byId.get(IDS[1]!)?.lien?.methode).toBe("nom_entente");
    expect(byId.get(IDS[1]!)?.lien?.confiance).toBe("basse");
  });

  it("n'inclut pas une entente qui ne concerne pas le club", async () => {
    const r = await listClubEquipesAvecPartenaires(CLUB, SAISON, { include_ententes: true });
    expect(r.map((e) => e.id_ffhb)).not.toContain(IDS[2]);
  });

  it("include_ententes=false et min_confidence=haute retirent les partenaires", async () => {
    const sans = await listClubEquipesAvecPartenaires(CLUB, SAISON, { include_ententes: false });
    expect(sans.map((e) => e.id_ffhb)).toEqual([IDS[0]]);
    const haute = await listClubEquipesAvecPartenaires(CLUB, SAISON, { include_ententes: true, min_confidence: "haute" });
    expect(haute.map((e) => e.id_ffhb)).toEqual([IDS[0]]);
  });
});
