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
