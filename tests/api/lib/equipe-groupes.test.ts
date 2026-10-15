import { describe, it, expect } from "vitest";
import { categorie, sexe, rang, estEntente, grouperEquipes, type EquipeEntree } from "@/api/lib/equipe-groupes.js";

const eq = (id: string, nom: string, competition: string, phase = "PHASE", niveau = "departemental"): EquipeEntree => ({
  id_ffhb: id,
  nom,
  engagements: [
    { competition: { id_ffhb: "C" + id, nom: competition, niveau }, phase: { id_ffhb: "P" + id, nom: phase }, poule: { id_ffhb: "O" + id, nom: "POULE" } },
  ],
});

describe("categorie", () => {
  it.each([
    ["57-14 -11 MASCULINS", "-11"],
    ["57-12 -13 MASCULINS", "-13"],
    ["57-08 -17MASCULINS", "-17"],
    ["57-26 COUPE ECHO'SPORT  -13 M", "-13"],
    ["CHAMPIONNAT -15 ANS MASCULIN", "-15"],
    ["CHAMPIONNAT M11 F", "-11"],
    ["COUPE D'AUTOMNE 2026 U15F", "-15"],
    ["U9 MIXTE", "-9"],
    ["C59 - MOINS DE 11 F DEPT H4", "-11"],
    ["TERRITORIAL U18 MASCULIN NIVEAU 1 26/27", "-18"],
    ["F120 - U13F - BRASSAGE NIV. HAUT ET PREPA HONNEUR", "-13"],
    ["CHAMPIONNAT HONNEUR MASCULIN", "Seniors"],
    ["F003 - 1RE DIVISION TERRITORIALE FEMININE", "Seniors"],
    ["NATIONALE 1 FEMININE 2026-2027", "Seniors"],
    ["LIGUE BUTAGAZ ENERGIE 2026-2027", "Seniors"],
    ["CHAMPIONNAT LOISIR", "Loisir"],
    ["COUPE DE FRANCE REGIONALE MASCULINE 2026-2027", "Seniors"],
    ["COUPE DE FRANCE DEPARTEMENTALE FEMININE 2026-2027", "Seniors"],
    ["COUPE DE FRANCE U18M", "-18"],
    ["TOURNOI DE NOEL", "Autre"],
  ])("%s → %s", (libelle, attendu) => expect(categorie(libelle)).toBe(attendu));

  it("ne confond ni un code de compétition (57-14) ni une saison (2026-2027) avec un âge", () => {
    expect(categorie("57-14 CHAMPIONNAT")).toBe("Autre");
    expect(categorie("COUPE 2026-2027")).toBe("Autre");
  });
});

describe("sexe", () => {
  it.each([
    ["57-14 -11 MASCULINS", "M"],
    ["CHAMPIONNAT M11 F", "F"],
    ["U13F - BRASSAGE", "F"],
    ["COUPE D'AUTOMNE 2026 U15M", "M"],
    ["57-26 COUPE ECHO'SPORT  -13 M", "M"],
    ["U17 FEMININS 2026-2027", "F"],
    ["LIGUE BUTAGAZ ENERGIE", "F"],
    ["U9 MIXTE", "mixte"],
  ])("%s → %s", (libelle, attendu) => expect(sexe(libelle)).toBe(attendu));
});

describe("rang et entente", () => {
  it("chiffre final, lettre entre parenthèses, défaut 1", () => {
    expect(rang("HBC SALLANCHES 2")).toBe(2);
    expect(rang("ENT BOUZONVILLE / BOULAY -13 M 1")).toBe(1);
    expect(rang("JDA DIJON HB (C)")).toBe(3);
    expect(rang("CONV. JDA/ FONTAINE (A)")).toBe(1);
    expect(rang("BOUZONVILLE HANDBALL")).toBe(1);
    expect(rang("JDA DIJON HANDBALL U11F")).toBe(1);
    expect(rang("ENT. JDA DIJON HB / VAROIS (U17)")).toBe(1);
  });
  it("détecte ententes et conventions", () => {
    expect(estEntente("ENT BOUZONVILLE / BOULAY")).toBe(true);
    expect(estEntente("ENT. JDA DIJON HB / VAROIS")).toBe(true);
    expect(estEntente("CONV. JDA/ FONTAINE (A)")).toBe(true);
    expect(estEntente("BOUZONVILLE HANDBALL")).toBe(false);
    expect(estEntente("CENTRE HANDBALL")).toBe(false);
  });
});

describe("grouperEquipes — Bouzonville Handball (8 inscriptions → 5 équipes réelles)", () => {
  const data = [
    eq("2134380", "BOUZONVILLE HANDBALL", "57-14 -11 MASCULINS", "57-TOURNOI QUALIFICATIONS -11M J1"),
    eq("2183373", "BOUZONVILLE HANDBALL", "57-28 COUPE ECHO'SPORT  -11 M", "57-COUPE ECHO'SPORT  -11 M 1° TOUR M"),
    eq("2166247", "ENT BOUZONVILLE / BOULAY", "57-08 -17MASCULINS", "57-CHAMPIONNAT -17 M"),
    eq("2164679", "ENT BOUZONVILLE / BOULAY -13 M 1", "57-12 -13 MASCULINS", "57- CHAMPIONNAT - 13 M"),
    eq("2183295", "ENT BOUZONVILLE / BOULAY -13 M 1", "57-26 COUPE ECHO'SPORT  -13 M", "57-COUPE ECHO'SPORT  -13 M 1° TOUR"),
    eq("2183215", "ENT BOUZONVILLE/BOULAY", "57-22 COUPE ECHO'SPORT  -17 M", "57- COUPE ECHO'SPORT -17 M 1° TOUR"),
    eq("2128182", "ENT BOUZONVILLE/BOULAY SM HON", "56-03 CHAMPIONNAT HONNEUR MASCULIN", "HONNEUR MASCULIN", "regional"),
    eq("2128307", "ENT BOUZONVILLE/BOULAY U15M", "56-07 CHAMPIONNAT -15 ANS MASCULIN", "-15 ANS MASCULIN REGIONAL PHASE 1", "regional"),
  ];
  const groupes = grouperEquipes(data);

  it("5 équipes réelles, triées Seniors puis catégories décroissantes", () => {
    expect(groupes.map((g) => g.libelle)).toEqual([
      "Seniors M — entente",
      "-17 M — entente",
      "-15 M — entente",
      "-13 M — entente",
      "-11 M",
    ]);
  });

  it("regroupe championnat et coupe d'une même équipe", () => {
    const by = (cle: string) => groupes.find((g) => g.cle === cle)!;
    expect(by("-11|M|1|club").equipes.map((e) => e.id_ffhb)).toEqual(["2134380", "2183373"]);
    expect(by("-13|M|1|entente").equipes.map((e) => e.id_ffhb)).toEqual(["2164679", "2183295"]);
    expect(by("-17|M|1|entente").equipes.map((e) => e.id_ffhb)).toEqual(["2166247", "2183215"]);
    expect(by("-11|M|1|club").competitions).toHaveLength(2);
  });

  it("aucune inscription perdue", () => {
    expect(groupes.flatMap((g) => g.equipes).map((e) => e.id_ffhb).sort()).toEqual(data.map((e) => e.id_ffhb).sort());
  });
});

describe("grouperEquipes — JDA Dijon (cas d'ententes, conventions et équipes réserves)", () => {
  const groupes = grouperEquipes([
    eq("2119942", "CONV. JDA/ FONTAINE (A)", "F120 - U13F - BRASSAGE NIV. HAUT ET PREPA HONNEUR"),
    eq("2119045", "ENT. JDA DIJON HB / VAROIS-ARC / MARSANNAY / COUCHEY-FIXIN-GEVREY (U17)", "U17 FEMININS 2026-2027"),
    eq("2118502", "JDA BOURGOGNE DIJON HANDBALL", "LIGUE BUTAGAZ ENERGIE 2026-2027", "PHASE", "national"),
    eq("2127844", "JDA DIJON HANDBALL", "NATIONALE 1 FEMININE 2026-2027", "PHASE", "national"),
    eq("2136659", "JDA DIJON HB (C)", "F003 - 1RE DIVISION TERRITORIALE FEMININE"),
    eq("2185302", "JDA DIJON HANDBALL U11F", "U11 FEMININES  - HAND A 7 -  S.2026-2027"),
    eq("2120030", "JDA DIJON HB", "F110 - U15F - BRASSAGE NIV. HAUT ET PREPA HONNEUR"),
  ]);

  it("classe correctement U13F, Butagaz et l'équipe réserve (C)", () => {
    const cles = groupes.map((g) => g.cle);
    expect(cles).toContain("-13|F|1|entente"); // convention (A), U13F lu comme féminin
    expect(cles).toContain("Seniors|F|1|club");
    expect(cles).toContain("Seniors|F|3|club"); // (C) = 3e équipe
    expect(cles).toContain("-17|F|1|entente");
    expect(cles).toContain("-11|F|1|club");
    expect(cles).toContain("-15|F|1|club");
  });

  it("n'a perdu aucune inscription", () => {
    expect(groupes.flatMap((g) => g.equipes)).toHaveLength(7);
  });

  // LIMITE CONNUE : « JDA BOURGOGNE DIJON HANDBALL » (Ligue Butagaz) et « JDA DIJON HANDBALL » (Nationale 1)
  // sont probablement deux équipes différentes, mais rien dans leurs noms ne le dit (même catégorie, même
  // sexe, même rang) : l'heuristique les fusionne. C'est ce que la future table de corrections manuelles
  // devra pouvoir séparer. Ce test documente le comportement actuel.
  it("fusionne (limite connue) deux équipes seniors de divisions différentes sans rang dans le nom", () => {
    const g = groupes.find((x) => x.cle === "Seniors|F|1|club")!;
    expect(g.equipes.map((e) => e.id_ffhb).sort()).toEqual(["2118502", "2127844"]);
    expect(g.competitions).toHaveLength(2);
  });
});

describe("grouperEquipes — seniors de Bouzonville : championnat + coupes + Coupe de France (ententes partenaires incluses)", () => {
  const groupes = grouperEquipes([
    eq("2128182", "ENT BOUZONVILLE/BOULAY SM HON", "56-03 CHAMPIONNAT HONNEUR MASCULIN", "HONNEUR MASCULIN", "regional"),
    // Entente dont Boulay est le porteur côté FFHB : « ENTENTE BOULAY/BOUZONVILLE SM »
    eq("2133862", "ENTENTE BOULAY/BOUZONVILLE SM", "57- 20 COUPE ECHO'SPORT SM", "57-COUPE ECHO'SPORT  SM 1° TOUR"),
    eq("2169469", "ENT BOUZONVILLE/BOULAY", "COUPE DE FRANCE REGIONALE MASCULINE 2026-2027", "CDF REG MAS (1° TOUR)", "national"),
  ]);

  it("les trois inscriptions forment UNE équipe réelle « Seniors M — entente »", () => {
    expect(groupes).toHaveLength(1);
    expect(groupes[0]!.libelle).toBe("Seniors M — entente");
    expect(groupes[0]!.equipes.map((e) => e.id_ffhb).sort()).toEqual(["2128182", "2133862", "2169469"]);
    expect(groupes[0]!.competitions).toHaveLength(3);
  });
});
