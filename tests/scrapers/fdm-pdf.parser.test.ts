// tests/scrapers/fdm-pdf.parser.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseFdmPdf } from "@/scrapers/ffhandball/fdm-pdf.parser.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

const SOURCE_URL = "https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/VAGPOQJ.pdf";

describe("parseFdmPdf — metadata (Page 1)", () => {
  it("extracts fdm_code, équipes, score from VAGPOQJ", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.fdm_code).toBe("VAGPOQJ");
    expect(r!.organisateur).toContain("LIGUE GRAND EST");
    expect(r!.competition_libelle).toContain("HONNEUR MASCULIN");
    expect(r!.equipe_recevant_libelle).toContain("ETAIN");
    expect(r!.equipe_visiteur_libelle).toContain("SARRALBE");
    expect(r!.score_recevant).toBe(23);
    expect(r!.score_visiteur).toBe(37);
    expect(r!.score_mi_temps_recevant).toBe(10);
    expect(r!.score_mi_temps_visiteur).toBe(17);
    expect(r!.statut_match).toBe("JOUE");
    expect(r!.date_heure_str).toContain("25/04/2026");
    expect(r!.salle_libelle).toContain("OMNISPORT DE LA GALAVAUDE");
    expect(r!.source_url).toBe(SOURCE_URL);
  });
});

describe("parseFdmPdf — officiels (Page 1)", () => {
  it("extracts table officiels with role + licence", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.officiels.length).toBeGreaterThan(2);

    // Chronométreur LODOVICI enzo
    const chrono = r!.officiels.find((o) => o.role === "chronometreur");
    expect(chrono).toBeDefined();
    expect(chrono!.nom).toBe("LODOVICI");
    expect(chrono!.prenom).toBe("enzo");
    expect(chrono!.numero_licence).toBe("5655011101546");

    // Juge Arbitre 1 ATAMNA emma
    const arb1 = r!.officiels.find((o) => o.role === "juge_arbitre_1");
    expect(arb1).toBeDefined();
    expect(arb1!.nom).toBe("ATAMNA");
  });
});

describe("parseFdmPdf — composition recevant (Page 1)", () => {
  it("extracts 11+ joueurs recevant with stats", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.composition_recevant.length).toBeGreaterThanOrEqual(10);

    // BAUDSON valentin n°25 — 3 buts, 8 tirs
    const baudson = r!.composition_recevant.find((j) => j.nom === "BAUDSON" && j.prenom === "valentin");
    expect(baudson).toBeDefined();
    expect(baudson!.numero_maillot).toBe(25);
    expect(baudson!.numero_licence).toBe("5655011101039");
    expect(baudson!.type_licence).toBe("A");
    expect(baudson!.buts).toBe(3);
    expect(baudson!.tirs).toBe(8);

    // MACEL dylan : capitaine X (préfixe X dans la ligne)
    const macel = r!.composition_recevant.find((j) => j.nom === "MACEL");
    expect(macel).toBeDefined();
    expect(macel!.capitaine).toBe(true);
    expect(macel!.numero_maillot).toBe(95);
  });
});

describe("parseFdmPdf — composition visiteur (Page 1)", () => {
  it("extracts joueurs visiteur with stats avancées", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();

    // GROSSE thomas : 3 buts, 3 tirs, avertissement X, 1 exclusion 2'
    const grosse = r!.composition_visiteur.find((j) => j.nom === "GROSSE" && j.prenom === "thomas");
    expect(grosse).toBeDefined();
    expect(grosse!.buts).toBe(3);
    expect(grosse!.tirs).toBe(3);
    expect(grosse!.avertissement).toBe(true);
    expect(grosse!.exclusions_2min).toBe(1);

    // NEMSGUERS michel : avertissement X + 2 exclusions
    const nem = r!.composition_visiteur.find((j) => j.nom === "NEMSGUERS");
    expect(nem!.avertissement).toBe(true);
    expect(nem!.exclusions_2min).toBe(2);

    // BLATNIK noah : capitaine X n°8
    const blatnik = r!.composition_visiteur.find((j) => j.nom === "BLATNIK");
    expect(blatnik!.capitaine).toBe(true);
  });
});

describe("parseFdmPdf — cas dégradés", () => {
  it("returns null on invalid PDF buffer", async () => {
    const r = await parseFdmPdf(Buffer.from("not a pdf"), SOURCE_URL, "INVALID");
    expect(r).toBeNull();
  });
});

describe("parseFdmPdf — actions (Page 2)", () => {
  it("extracts chronological actions from VAGPOQJ déroulé", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.actions.length).toBeGreaterThan(40);

    // 1ère action : 02:41 — Arrêt JR N°95 MACEL dylan
    const first = r!.actions[0]!;
    expect(first.ordre).toBe(0);
    expect(first.periode).toBe(1);
    expect(first.temps_seconds).toBe(2 * 60 + 41);
    expect(first.type_action).toBe("arret");
    expect(first.cote).toBe("recevant");
    expect(first.numero_maillot).toBe(95);
    expect(first.acteur_role).toBe("joueur");
  });

  it("recognizes buts and tirs with cote dom/ext", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const buts = r!.actions.filter((a) => a.type_action === "but");
    const tirs = r!.actions.filter((a) => a.type_action === "tir");
    expect(buts.length).toBeGreaterThan(10);
    expect(tirs.length).toBeGreaterThan(5);
    expect(buts.every((b) => b.cote === "recevant" || b.cote === "visiteur")).toBe(true);
  });

  it("parses sanctions (avertissement, 2MN)", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const avert = r!.actions.find((a) => a.type_action === "avertissement");
    expect(avert).toBeDefined();
    const exclu = r!.actions.find((a) => a.type_action === "exclusion_2min");
    expect(exclu).toBeDefined();
  });

  it("parses temps mort with cote", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const tm = r!.actions.find((a) => a.type_action === "temps_mort_recevant" || a.type_action === "temps_mort_visiteur");
    expect(tm).toBeDefined();
  });

  it("recognizes protocole commotion", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const pc = r!.actions.find((a) => a.type_action === "protocole_commotion");
    expect(pc).toBeDefined();
    expect(pc!.acteur_role).toBe("joueur");
  });

  it("ordre is strictly monotonic (0, 1, 2, ...)", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    for (let i = 0; i < r!.actions.length; i++) {
      expect(r!.actions[i]!.ordre).toBe(i);
    }
  });
});
