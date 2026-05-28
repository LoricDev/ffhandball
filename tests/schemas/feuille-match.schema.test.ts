// tests/schemas/feuille-match.schema.test.ts
import { describe, it, expect } from "vitest";
import {
  rawFeuilleMatchPayloadSchema,
  rawJoueurInFdmSchema,
  rawOfficielInFdmSchema,
  rawActionInFdmSchema,
} from "@/schemas/feuille-match.schema.js";

describe("rawJoueurInFdmSchema", () => {
  it("accepts a complete joueur", () => {
    const r = rawJoueurInFdmSchema.safeParse({
      numero_licence: "5655011101039",
      nom: "BAUDSON",
      prenom: "valentin",
      type_licence: "A",
      numero_maillot: 25,
      capitaine: false,
      gardien: false,
      buts: 3,
      sept_metres_reussis: null,
      sept_metres_tentes: null,
      tirs: 8,
      arrets: null,
      avertissement: false,
      exclusions_2min: null,
      disqualifie: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects malformed numero_licence", () => {
    const r = rawJoueurInFdmSchema.safeParse({
      numero_licence: "ABC", nom: "X", prenom: "Y", type_licence: "A",
      numero_maillot: 1, capitaine: false, gardien: false,
      buts: 0, sept_metres_reussis: 0, sept_metres_tentes: 0,
      tirs: 0, arrets: 0, avertissement: false, exclusions_2min: 0, disqualifie: false,
    });
    expect(r.success).toBe(false);
  });
});

describe("rawOfficielInFdmSchema", () => {
  it("accepts complete officiel", () => {
    const r = rawOfficielInFdmSchema.safeParse({
      role: "chronometreur",
      cote: "recevant",
      nom: "LODOVICI",
      prenom: "enzo",
      numero_licence: "5655011101546",
    });
    expect(r.success).toBe(true);
  });
});

describe("rawActionInFdmSchema", () => {
  it("accepts a but action", () => {
    const r = rawActionInFdmSchema.safeParse({
      ordre: 1,
      periode: 1,
      temps_seconds: 180,  // 03:00
      score_recevant: 1,
      score_visiteur: 0,
      type_action: "but",
      cote: "recevant",
      numero_maillot: 22,
      acteur_role: "joueur",
      description_brute: "But JR N°22 SUSSENAIRE romain",
    });
    expect(r.success).toBe(true);
  });
});

describe("rawFeuilleMatchPayloadSchema", () => {
  it("accepts a complete payload", () => {
    const r = rawFeuilleMatchPayloadSchema.safeParse({
      fdm_code: "VAGPOQJ",
      organisateur: "LIGUE GRAND EST DE HANDBALL",
      competition_libelle: "CHAMPIONNAT HONNEUR MASCULIN",
      equipe_recevant_libelle: "ETAIN",
      equipe_visiteur_libelle: "SARRALBE",
      date_heure_str: "samedi 25/04/2026 20:30",
      score_recevant: 23,
      score_visiteur: 37,
      score_mi_temps_recevant: 10,
      score_mi_temps_visiteur: 17,
      statut_match: "JOUE",
      officiels: [],
      composition_recevant: [],
      composition_visiteur: [],
      actions: [],
      source_url: "https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/VAGPOQJ.pdf",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty fdm_code", () => {
    const r = rawFeuilleMatchPayloadSchema.safeParse({
      fdm_code: "",
      equipe_recevant_libelle: "X",
      equipe_visiteur_libelle: "Y",
      date_heure_str: "Z",
      officiels: [], composition_recevant: [], composition_visiteur: [], actions: [],
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed source_url", () => {
    const r = rawFeuilleMatchPayloadSchema.safeParse({
      fdm_code: "X",
      equipe_recevant_libelle: "X", equipe_visiteur_libelle: "Y",
      date_heure_str: "Z",
      officiels: [], composition_recevant: [], composition_visiteur: [], actions: [],
      source_url: "not-a-url",
    });
    expect(r.success).toBe(false);
  });
});
