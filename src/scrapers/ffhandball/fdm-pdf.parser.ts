// src/scrapers/ffhandball/fdm-pdf.parser.ts
import { extractPdfText } from "@/lib/pdf-parser.js";
import {
  rawFeuilleMatchPayloadSchema,
  type RawFeuilleMatchPayload,
  type RawJoueurInFdm,
  type RawOfficielInFdm,
  type RawActionInFdm,
} from "@/schemas/feuille-match.schema.js";
import { logger } from "@/lib/logger.js";

// ============================================================================
// Helpers
// ============================================================================

/** Parse une string entière potentiellement vide (colonnes tableau). */
function parseIntOrNull(s: string | undefined): number | null {
  if (!s || s.trim() === "") return null;
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Convertit "mm:ss" en secondes. */
function timeToSeconds(timeStr: string): number {
  const [m, s] = timeStr.split(":").map(Number);
  return (m ?? 0) * 60 + (s ?? 0);
}

// ============================================================================
// Page 1 : Header + Score
// ============================================================================

interface HeaderResult {
  organisateur?: string;
  organisateur_code?: string;
  competition_libelle?: string;
  groupe?: string;
  poule_libelle?: string;
  equipe_recevant_libelle: string;
  equipe_visiteur_libelle: string;
  date_heure_str: string;
  journee_libelle?: string;
  salle_libelle?: string;
  salle_adresse?: string;
  score_recevant: number | null;
  score_visiteur: number | null;
  score_mi_temps_recevant: number | null;
  score_mi_temps_visiteur: number | null;
  statut_match?: string;
}

function parseHeader(page1Text: string, _fdmCode: string): HeaderResult | null {
  const lines = page1Text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Organisateur : "Organisateur LIGUE GRAND EST DE HANDBALL (5600000) Code Renc VAGPOQJ"
  const orgLine = lines.find((l) => l.startsWith("Organisateur"));
  const orgMatch = orgLine?.match(/Organisateur\s+(.+?)\s*\((\d+)\)/);
  const organisateur = orgMatch?.[1]?.trim();
  const organisateur_code = orgMatch?.[2];

  // Compétition : "Compétition 56-03 CHAMPIONNAT HONNEUR MASCULIN HONNEUR MASCULIN"
  const compLine = lines.find((l) => l.startsWith("Compétition") || l.startsWith("Competition"));
  const competition_libelle = compLine?.replace(/^Comp[eé]tition\s+\S+\s+/, "").trim();

  // Poule + Groupe : "56-HONNEUR MASC POULE 3 Groupe M56000202G"
  const pouleLine = lines.find((l) => l.includes("Groupe") && !l.includes("Code Renc") && !l.startsWith("Organisateur") && !l.startsWith("Compétition"));
  const pouleMatch = pouleLine?.match(/^(.+?)\s+Groupe\s+(.+)$/);
  const poule_libelle = pouleMatch?.[1]?.trim();
  const groupe = pouleMatch?.[2]?.trim();

  // Équipes + score final : "ETAIN RAYON ARTISTIQUE SPORTIF STAINOIS / SARRALBE 23 37"
  const matchLine = lines.find((l) => l.includes(" / ") && /\d+\s+\d+\s*$/.test(l));
  const matchMatch = matchLine?.match(/^(.+?)\s*\/\s*(.+?)\s+(\d+)\s+(\d+)\s*$/);
  if (!matchMatch) return null;
  const equipe_recevant_libelle = matchMatch[1]!.trim();
  const equipe_visiteur_libelle = matchMatch[2]!.trim();
  const score_recevant = parseInt(matchMatch[3]!, 10);
  const score_visiteur = parseInt(matchMatch[4]!, 10);

  // Date : "DATE: samedi 25/04/2026 20:30 Journée / Date"
  const dateLine = lines.find((l) => l.startsWith("DATE:"));
  const dateMatch = dateLine?.match(/^DATE:\s*(.+?)(?:\s+Journ[eé]e|$)/);
  const date_heure_str = dateMatch?.[1]?.trim() ?? "";

  // Journée : "J18 du 28/03/26 au 29/03/26" or "Inintiale J18 du..."
  const journeeMatch = page1Text.match(/J\d+\s+du\s+[\d/]+\s+au\s+[\d/]+/);
  const journee_libelle = journeeMatch?.[0];

  // Salle : "SALLE: 5655 - OMNISPORT DE LA GALAVAUDE"
  const salleMatch = page1Text.match(/SALLE:\s*(.+?)(?:\n|$)/);
  const salle_raw = salleMatch?.[1]?.trim();
  // Remove leading code like "5655 - "
  const salle_libelle = salle_raw?.replace(/^\d+\s*-\s*/, "").trim();
  // Address is on the next line after SALLE
  const salleIdx = lines.findIndex((l) => l.includes("SALLE:"));
  const salle_adresse = salleIdx >= 0 && salleIdx + 1 < lines.length ? lines[salleIdx + 1] : undefined;

  // Score mi-temps : from "DETAIL SCORE" section
  // Format: "10 17 23 37" where first two numbers are mi-temps (période 1)
  // The line appears after the "REC VIS REC VIS ..." header line
  const detailScoreIdx = page1Text.indexOf("DETAIL");
  let score_mi_temps_recevant: number | null = null;
  let score_mi_temps_visiteur: number | null = null;

  if (detailScoreIdx >= 0) {
    const detailText = page1Text.slice(detailScoreIdx);
    // Find the line with 4 numbers: "10 17 23 37"
    const scoreLine = detailText.split("\n").find((l) => /^\s*\d+\s+\d+(\s+\d+)*\s*$/.test(l.trim()));
    if (scoreLine) {
      const parts = scoreLine.trim().split(/\s+/).map((s) => parseInt(s, 10));
      if (parts.length >= 2) {
        score_mi_temps_recevant = parts[0]!;
        score_mi_temps_visiteur = parts[1]!;
      }
    }
  }

  // Statut Match : "Statut Match :JOUE"
  const statutMatch = page1Text.match(/Statut Match\s*:\s*(\w+)/);
  const statut_match = statutMatch?.[1];

  return {
    organisateur,
    organisateur_code,
    competition_libelle,
    groupe,
    poule_libelle,
    equipe_recevant_libelle,
    equipe_visiteur_libelle,
    date_heure_str,
    journee_libelle,
    salle_libelle,
    salle_adresse,
    score_recevant,
    score_visiteur,
    score_mi_temps_recevant,
    score_mi_temps_visiteur,
    statut_match,
  };
}

// ============================================================================
// Page 1 : Officiels de table
// ============================================================================

// Ordered by label so that longer labels match first (avoid partial matches)
const OFFICIEL_ROLES: Array<[string, string]> = [
  ["Juge Arbitre 1", "juge_arbitre_1"],
  ["Juge Arbitre 2", "juge_arbitre_2"],
  ["Juge Délégué", "juge_delegue"],
  ["Délégué Officiel", "delegue_officiel"],
  ["Tuteur de Table", "tuteur_table"],
  ["Responsable de Salle", "responsable_salle"],
  ["Responsable de", "responsable_salle"],
  ["Chronométreur", "chronometreur"],
  ["Secrétaire", "secretaire"],
  ["Accompagnateur", "accompagnateur"],
  ["Délégué", "delegue"],
  ["Speaker", "speaker"],
  ["Juge", "juge"],
];

function parseOfficiels(page1Text: string): RawOfficielInFdm[] {
  const officiels: RawOfficielInFdm[] = [];

  for (const [label, role] of OFFICIEL_ROLES) {
    // Pattern: "Chronométreur LODOVICI enzo 5655011101546"
    // Allow the label to be followed by the person data
    // NOM = one or more all-caps tokens (with hyphen/apostrophe allowed)
    // prenom = first lowercase token
    // licence = 10-13 digits
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `${escaped}\\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ][A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ'\\-]*)(?:\\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ][A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ'\\-]*))*\\s+([a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüý][a-zA-Z'\\- ]*)\\s+(\\d{10,13})`,
      "g"
    );

    // Simpler approach: after the label, match NOM(s) prenom licence
    // NOM = sequence of all-uppercase words, prenom = first word with lowercase
    const simpleRe = new RegExp(
      `${escaped}\\s+((?:[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ][A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ'\\-]+\\s+)+)([a-z][a-zA-Z'\\-]*)\\s+(\\d{10,13})`,
      "g"
    );

    let m;
    while ((m = simpleRe.exec(page1Text)) !== null) {
      const nom = m[1]!.trim();
      const prenom = m[2]!.trim();
      const numero_licence = m[3]!;
      // Skip if already added this person
      if (!officiels.find((o) => o.role === role && o.nom === nom)) {
        officiels.push({
          role,
          cote: "neutre",
          nom,
          prenom,
          numero_licence,
        });
      }
    }
  }

  return officiels;
}

// ============================================================================
// Page 1 : Composition équipe
// ============================================================================

/**
 * Parse les colonnes de statistiques d'une ligne joueur.
 *
 * Colonnes: Buts | 7m | Tirs | Arrets | Av.(X) | 2'(nb) | Dis(X)
 *
 * Règle heuristique basée sur les tokens observés (pdf-parse compresse les espaces) :
 * - Tokens numériques AVANT le 1er X : assignés à Buts, [7m,] Tirs, [Arrets]
 *   - 1 token  → Buts
 *   - 2 tokens → Buts, Tirs     (7m absent)
 *   - 3 tokens → Buts, 7m, Tirs
 *   - 4 tokens → Buts, 7m, Tirs, Arrets
 * - 1er X → avertissement=true
 * - Token numérique APRÈS 1er X → exclusions_2min
 * - 2e X → disqualifie=true
 */
function parseStatsColumns(cols: string[]): {
  buts: number | null;
  sept_metres_reussis: number | null;
  sept_metres_tentes: number | null;
  tirs: number | null;
  arrets: number | null;
  avertissement: boolean;
  exclusions_2min: number | null;
  disqualifie: boolean;
} {
  const firstXIdx = cols.indexOf("X");
  const beforeX = firstXIdx === -1 ? cols : cols.slice(0, firstXIdx);
  const afterX = firstXIdx === -1 ? [] : cols.slice(firstXIdx + 1);

  const numsBeforeX: number[] = [];
  for (const c of beforeX) {
    if (/^\d+$/.test(c)) numsBeforeX.push(parseInt(c, 10));
  }

  let buts: number | null = null;
  let sept_metres_reussis: number | null = null;
  const sept_metres_tentes: number | null = null;
  let tirs: number | null = null;
  let arrets: number | null = null;

  if (numsBeforeX.length === 1) {
    buts = numsBeforeX[0] ?? null;
  } else if (numsBeforeX.length === 2) {
    buts = numsBeforeX[0] ?? null;
    tirs = numsBeforeX[1] ?? null;  // 7m absent
  } else if (numsBeforeX.length === 3) {
    buts = numsBeforeX[0] ?? null;
    sept_metres_reussis = numsBeforeX[1] ?? null;
    tirs = numsBeforeX[2] ?? null;
  } else if (numsBeforeX.length >= 4) {
    buts = numsBeforeX[0] ?? null;
    sept_metres_reussis = numsBeforeX[1] ?? null;
    tirs = numsBeforeX[2] ?? null;
    arrets = numsBeforeX[3] ?? null;
  }

  // Handle slash format "3/4" for arrets or 7m
  for (const c of beforeX) {
    if (c.includes("/")) {
      const [a, b] = c.split("/").map((s) => parseInt(s.trim(), 10));
      if (Number.isFinite(a)) sept_metres_reussis = a!;
      if (Number.isFinite(b)) {
        // sept_metres_tentes not in our output but could be stored elsewhere
        tirs = b ?? null;
      }
    }
  }

  // After X: 1st number = exclusions_2min
  const numsAfterX: number[] = [];
  let secondX = false;
  for (const c of afterX) {
    if (c === "X") { secondX = true; break; }
    if (/^\d+$/.test(c)) numsAfterX.push(parseInt(c, 10));
  }

  const avertissement = firstXIdx !== -1;
  const exclusions_2min = numsAfterX[0] ?? null;
  const disqualifie = secondX;

  // Gardien heuristique: arrets non-null ou (4+ tokens before X)
  if (arrets === null && numsBeforeX.length >= 4) {
    arrets = numsBeforeX[3] ?? null;
  }

  return {
    buts,
    sept_metres_reussis,
    sept_metres_tentes,
    tirs,
    arrets,
    avertissement,
    exclusions_2min,
    disqualifie,
  };
}

/**
 * Parse une ligne joueur :
 *   [X] N° NOM prenom(parts) LICENCE TYPE [stats...]
 *
 * Exemples :
 *   "25 BAUDSON valentin 5655011101039 A 3 8"
 *   "X 95 MACEL dylan 5655011101499 A 1 1 2"
 *   "23 GROSSE thomas 5657027100959 A 3 3 X 1"
 *   "87 MEYER tom - MEYER-MATTA 5657027100665 A 8 9"
 */
function parseJoueurLine(line: string): RawJoueurInFdm | null {
  let working = line.trim();

  // 1. Détecter capitaine (X en début)
  const capitaine = working.startsWith("X ");
  if (capitaine) working = working.slice(2).trim();

  // 2. Extraire : numero_maillot NOM... prenom... LICENCE TYPE [stats...]
  // NOM = sequence of uppercase tokens (may include hyphen)
  // prenom = lowercase tokens (may include " - " or mixed case for composés)
  // LICENCE = 10-13 digit string
  // TYPE = single uppercase letter
  const match = working.match(/^(\d+)\s+(.+?)\s+(\d{10,13})\s+([A-Z])\s*(.*)$/);
  if (!match) return null;

  const numero_maillot = parseInt(match[1]!, 10);
  const nomPrenom = match[2]!.trim();
  const numero_licence = match[3]!;
  const type_licence = match[4]!;
  const statsStr = match[5]!.trim();

  // 3. Séparer NOM / prenom
  // NOM = leading all-uppercase tokens; prenom = remaining tokens
  // Handle composed names like "MEYER tom - MEYER-MATTA" → NOM=MEYER, prenom="tom - MEYER-MATTA"
  const tokens = nomPrenom.split(/\s+/);
  const nomTokens: string[] = [];
  const prenomTokens: string[] = [];
  let inPrenom = false;

  for (const t of tokens) {
    // A token is "NOM part" if it's all uppercase (accents included) and we haven't started prenom
    if (!inPrenom && /^[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ][A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ'\\-]*$/.test(t)) {
      nomTokens.push(t);
    } else {
      inPrenom = true;
      prenomTokens.push(t);
    }
  }

  const nom = nomTokens.join(" ") || "?";
  const prenom = prenomTokens.join(" ") || "?";

  // 4. Stats
  const cols = statsStr.split(/\s+/).filter((c) => c.length > 0);
  const stats = parseStatsColumns(cols);

  // Gardien : heuristique — si arrets non-null
  const gardien = (stats.arrets ?? 0) > 0;

  return {
    numero_licence,
    nom,
    prenom,
    type_licence,
    numero_maillot,
    capitaine,
    gardien,
    buts: stats.buts,
    sept_metres_reussis: stats.sept_metres_reussis,
    sept_metres_tentes: stats.sept_metres_tentes,
    tirs: stats.tirs,
    arrets: stats.arrets,
    avertissement: stats.avertissement,
    exclusions_2min: stats.exclusions_2min,
    disqualifie: stats.disqualifie,
  };
}

function parseComposition(page1Text: string, section: "recevant" | "visiteur"): RawJoueurInFdm[] {
  const lines = page1Text.split("\n");
  const marker = section === "recevant" ? "Club Recevant" : "Club Visiteur";

  // Find the section start
  const startIdx = lines.findIndex((l) => l.includes(marker));
  if (startIdx < 0) return [];

  // For "recevant", end at "Club Visiteur" or "DETAIL"
  // For "visiteur", end at "DETAIL" or end of text
  let endIdx: number;
  if (section === "recevant") {
    const visIdx = lines.findIndex((l, i) => i > startIdx && l.includes("Club Visiteur"));
    const detailIdx = lines.findIndex((l, i) => i > startIdx && l.includes("DETAIL"));
    endIdx = Math.min(
      visIdx > 0 ? visIdx : Infinity,
      detailIdx > 0 ? detailIdx : Infinity,
    );
    if (!isFinite(endIdx)) endIdx = lines.length;
  } else {
    const detailIdx = lines.findIndex((l, i) => i > startIdx && l.includes("DETAIL"));
    endIdx = detailIdx > 0 ? detailIdx : lines.length;
  }

  const sliceLines = lines.slice(startIdx, endIdx);

  const joueurs: RawJoueurInFdm[] = [];
  for (const line of sliceLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip headers and section markers
    if (
      trimmed.startsWith("Club ") ||
      trimmed.startsWith("Capt") ||
      trimmed.startsWith("N°") ||
      trimmed.startsWith("Officiel") ||
      trimmed.startsWith("Kiné") ||
      trimmed.startsWith("Médecin") ||
      /^\d{7}\s*$/.test(trimmed)  // lone 7-digit licence prefix
    ) continue;

    // Try to parse as a joueur line
    const j = parseJoueurLine(trimmed);
    if (j) joueurs.push(j);
  }

  return joueurs;
}

// ============================================================================
// Page 2 — déroulé chronologique (T5)
// ============================================================================

type ActionType = RawActionInFdm["type_action"];

function parseActionDescription(
  desc: string,
): Omit<RawActionInFdm, "ordre" | "periode" | "temps_seconds" | "score_recevant" | "score_visiteur" | "description_brute"> | null {
  // Temps mort
  if (/Temps Mort.*Recevant/i.test(desc)) {
    return { type_action: "temps_mort_recevant", cote: "recevant" };
  }
  if (/Temps Mort.*Visiteur/i.test(desc)) {
    return { type_action: "temps_mort_visiteur", cote: "visiteur" };
  }

  // Pattern: "TypeAction J{R|V} N°NN NOM prenom" or "TypeAction O{R|V} NOM prenom"
  const acteurMatch = desc.match(/^(.+?)\s+(J|O)([RV])(?:\s+N°(\d+))?\s+(.+)$/);
  if (!acteurMatch) {
    return { type_action: "autre" };
  }

  const typeWord = acteurMatch[1]!.trim();
  const acteurType = acteurMatch[2]!;  // J ou O
  const coteCode = acteurMatch[3]!;    // R ou V
  const numero = acteurMatch[4] ? parseInt(acteurMatch[4], 10) : null;

  const cote: "recevant" | "visiteur" = coteCode === "R" ? "recevant" : "visiteur";
  const acteur_role: "joueur" | "officiel" = acteurType === "J" ? "joueur" : "officiel";

  let type_action: ActionType = "autre";

  if (/^But$/i.test(typeWord)) type_action = "but";
  else if (/^Tir$/i.test(typeWord)) type_action = "tir";
  else if (/^Arr[eê]t$/i.test(typeWord)) type_action = "arret";
  else if (/^Avertissement$/i.test(typeWord)) type_action = "avertissement";
  else if (/^2MN$/i.test(typeWord) || /2\s*Minutes?/i.test(typeWord)) type_action = "exclusion_2min";
  else if (/Disqualification/i.test(typeWord)) type_action = "disqualification";
  else if (/Protocole.*Commotion/i.test(typeWord) || /Commotion/i.test(typeWord)) type_action = "protocole_commotion";

  return {
    type_action,
    cote,
    numero_maillot: numero,
    acteur_role,
  };
}

function parseActions(page2Text: string): RawActionInFdm[] {
  const lines = page2Text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const actions: RawActionInFdm[] = [];

  let currentPeriode = 1;
  let ordre = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Détecter changement de période
    if (/^PERIODE\s+1$/i.test(line)) { currentPeriode = 1; continue; }
    if (/^PERIODE\s+2$/i.test(line)) { currentPeriode = 2; continue; }
    if (/^PERIODE\s+3$/i.test(line)) { currentPeriode = 3; continue; }
    if (/^PERIODE\s+4$/i.test(line)) { currentPeriode = 4; continue; }

    // Match "mm:ss NN - MM [description optionnelle]"
    // In pdf-parse v2 output, the line may have tabs: "02:41 00 - 00\t\n"
    // and the description is on the next line
    const m = line.match(/^(\d{1,2}:\d{2})\s+(\d+)\s*-\s*(\d+)(.*)$/);
    if (!m) continue;

    const tempsStr = m[1]!;
    const scoreR = parseInt(m[2]!, 10);
    const scoreV = parseInt(m[3]!, 10);
    let description = m[4]!.trim().replace(/^\t+/, "").trim();

    // Si description vide (or only tabs), action est sur la ligne suivante
    if (!description && i + 1 < lines.length) {
      description = lines[i + 1]!.trim();
      i++;  // skip line consumed
    }

    if (!description) continue;

    const action = parseActionDescription(description);
    if (!action) continue;

    actions.push({
      ordre,
      periode: currentPeriode,
      temps_seconds: timeToSeconds(tempsStr),
      score_recevant: scoreR,
      score_visiteur: scoreV,
      ...action,
      description_brute: description,
    });
    ordre++;
  }

  return actions;
}

// ============================================================================
// Fonction publique
// ============================================================================

export async function parseFdmPdf(
  buffer: Buffer,
  sourceUrl: string,
  fdmCode: string,
): Promise<RawFeuilleMatchPayload | null> {
  const extracted = await extractPdfText(buffer);
  if (!extracted || extracted.pages.length < 1) {
    logger.warn({ fdmCode }, "FdM PDF parsing failed or incomplete");
    return null;
  }

  const page1 = extracted.pages[0]!;
  const page2 = extracted.pages[1] ?? "";

  const header = parseHeader(page1, fdmCode);
  if (!header) {
    logger.warn({ fdmCode }, "FdM header parsing failed");
    return null;
  }

  const officiels = parseOfficiels(page1);
  const composition_recevant = parseComposition(page1, "recevant");
  const composition_visiteur = parseComposition(page1, "visiteur");
  const actions = parseActions(page2);

  const candidate = {
    fdm_code: fdmCode,
    ...header,
    officiels,
    composition_recevant,
    composition_visiteur,
    actions,
    source_url: sourceUrl,
    pdf_size_bytes: buffer.length,
  };

  const parsed = rawFeuilleMatchPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    logger.warn({ fdmCode, errors: parsed.error.message }, "FdM Zod validation failed");
    return null;
  }
  return parsed.data;
}
