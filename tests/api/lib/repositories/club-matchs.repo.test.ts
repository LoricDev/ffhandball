// tests/api/lib/repositories/club-matchs.repo.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { getClubMatchsCalendar } from "@/api/lib/repositories/club-matchs.repo.js";

const SAISON = "2025-2026";
const CLUB_A = "5655011"; // entente member A
const CLUB_B = "6275001"; // entente member B

let pouleId: bigint;
let equipeEntenteId: bigint;
let equipeStructId: bigint;
let equipeAdvId: bigint;

async function seedJoueur(licence: string, nom: string): Promise<bigint> {
  const r = await query<{ id: bigint }>(
    `INSERT INTO core.joueurs (numero_licence, nom, prenom)
     VALUES ($1, $2, 'X')
     ON CONFLICT (numero_licence) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [licence, nom],
  );
  return r.rows[0]!.id;
}

async function addComposition(matchId: bigint, joueurId: bigint, equipeId: bigint): Promise<void> {
  await query(
    `INSERT INTO core.match_compositions (match_id, joueur_id, equipe_id)
     VALUES ($1, $2, $3) ON CONFLICT (match_id, joueur_id) DO NOTHING`,
    [matchId, joueurId, equipeId],
  );
}

beforeAll(async () => {
  // Nettoyage ciblé
  await query(
    `DELETE FROM core.match_compositions WHERE joueur_id IN (SELECT id FROM core.joueurs WHERE numero_licence LIKE '5655011%' OR numero_licence LIKE '6275001%')`,
  );
  await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'PREC-M-%'`);
  await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'PREC-EQ-%' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.poules WHERE id_ffhb = 'PREC-PO' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.phases WHERE id_ffhb = 'PREC-PH' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.competitions WHERE id_ffhb = 'PREC-COMP'`);
  await query(`DELETE FROM core.clubs WHERE id_ffhb IN ($1, $2)`, [CLUB_A, CLUB_B]);
  await query(`DELETE FROM core.joueurs WHERE numero_licence LIKE '5655011%' OR numero_licence LIKE '6275001%'`);

  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30') ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
  await query(
    `INSERT INTO core.clubs (id_ffhb, nom, last_seen_at) VALUES
       ($1, 'CLUB ALPHA HANDBALL', now()), ($2, 'CLUB BETA HANDBALL', now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
    [CLUB_A, CLUB_B],
  );
  const comp = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('PREC-COMP', 'Comp Prec', 'national', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const ph = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('PREC-PH', $1, 'Ph', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const po = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ('PREC-PO', $1, 'Po', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [ph.rows[0]!.id, SAISON],
  );
  pouleId = po.rows[0]!.id;

  // Équipes
  const ent = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('PREC-EQ-ENT', 'ENTENTE GAMMA DELTA', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  equipeEntenteId = ent.rows[0]!.id;
  const struct = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, ext_structure_id, saison_code, last_seen_at)
     VALUES ('PREC-EQ-STR', 'EQUIPE STRUCT ALPHA', $1, $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET ext_structure_id = EXCLUDED.ext_structure_id RETURNING id`,
    [CLUB_A, SAISON],
  );
  equipeStructId = struct.rows[0]!.id;
  const adv = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('PREC-EQ-ADV', 'ADVERSAIRE NEUTRE', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  equipeAdvId = adv.rows[0]!.id;

  // Match de l'entente (à domicile) + match de l'équipe structure
  const m1 = await query<{ id: bigint }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut)
     VALUES ('PREC-M-001', $1, $2, $3, '2025-10-01T20:00:00Z', 'joue')
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut RETURNING id`,
    [pouleId, equipeEntenteId, equipeAdvId],
  );
  await query(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut)
     VALUES ('PREC-M-002', $1, $2, $3, '2025-10-08T20:00:00Z', 'joue')
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut`,
    [pouleId, equipeStructId, equipeAdvId],
  );

  // Compositions : 3 licenciés A + 3 licenciés B dans l'entente → n_distinct_clubs=2
  for (let i = 1; i <= 3; i++) {
    const jA = await seedJoueur(`5655011${100000 + i}`, `JOUEUR_A${i}`);
    const jB = await seedJoueur(`6275001${100000 + i}`, `JOUEUR_B${i}`);
    await addComposition(m1.rows[0]!.id, jA, equipeEntenteId);
    await addComposition(m1.rows[0]!.id, jB, equipeEntenteId);
  }
});

describe("getClubMatchsCalendar — couches de précision", () => {
  it("lie l'entente au club A via la couche licence (≥3 licenciés) avec is_entente", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_A,
      saison: SAISON,
      include_ententes: true,
      limit: 50,
      offset: 0,
    });
    const ent = r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA");
    expect(ent).toBeDefined();
    expect(ent!.match_method).toBe("licence");
    expect(ent!.confidence).toBe("haute");
    expect(ent!.is_entente).toBe(true);
    // Le club A est aussi lié à son équipe structure
    const str = r.equipes_liees.find((e) => e.nom === "EQUIPE STRUCT ALPHA");
    expect(str!.match_method).toBe("structure");
    // Les matchs incluent celui de l'entente
    expect(r.matchs.map((m) => m.id_ffhb_match)).toContain("PREC-M-001");
  });

  it("lie l'entente au club B aussi (ses licenciés y ont joué)", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_B,
      saison: SAISON,
      include_ententes: true,
      limit: 50,
      offset: 0,
    });
    expect(r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA")).toBeDefined();
  });

  it("min_confidence=haute conserve licence et structure (haute)", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_A,
      saison: SAISON,
      include_ententes: true,
      min_confidence: "haute",
      limit: 50,
      offset: 0,
    });
    expect(r.equipes_liees.every((e) => e.confidence === "haute")).toBe(true);
    expect(r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA")).toBeDefined();
  });

  it("exclut l'entente quand include_ententes=false", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_A,
      saison: SAISON,
      include_ententes: false,
      limit: 50,
      offset: 0,
    });
    expect(r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA")).toBeUndefined();
    // structure (non-entente) reste
    expect(r.equipes_liees.find((e) => e.nom === "EQUIPE STRUCT ALPHA")).toBeDefined();
  });

  afterAll(async () => {
    await closePool();
  });
});
