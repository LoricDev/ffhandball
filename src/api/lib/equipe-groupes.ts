// src/api/lib/equipe-groupes.ts — regroupe les « équipes » FFHB en équipes réelles.
//
// Chez FFHB, une « équipe » (id_ffhb) est une INSCRIPTION à une compétition : la même équipe réelle
// (ex. le -11M de Bouzonville) apparaît une fois pour le championnat et une fois pour la coupe, avec
// des identifiants différents. Le seul indice stable est le nom de la compétition (« 57-14 -11
// MASCULINS », « COUPE ECHO'SPORT -13 M »), pas celui de l'équipe (souvent « CLUB HANDBALL » sans
// catégorie). On déduit donc catégorie, sexe, rang et entente, puis on groupe sur ces quatre critères.
//
// C'est une HEURISTIQUE : elle couvre les nommages courants mais pas tous. Ce qu'elle ne sait pas
// classer tombe en « Autre » (jamais perdu). Voir tests/api/lib/equipe-groupes.test.ts.

export type Categorie = "Seniors" | "-20" | "-19" | "-18" | "-17" | "-15" | "-13" | "-11" | "-9" | "-7" | "Loisir" | "Autre";
export type Sexe = "M" | "F" | "mixte";

const AGES = [7, 9, 11, 13, 15, 17, 18, 19, 20];

const strip = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();

/** Catégorie d'âge déduite d'un libellé (compétition, phase ou nom d'équipe). */
export function categorie(libelle: string): Categorie {
  const n = strip(libelle);
  // -11, - 13, U15, M11, MOINS DE 13 ; le préfixe non alphanumérique ignore les codes (« 57-14 »).
  const age = n.match(/(?:^|[^A-Z0-9])(?:-|MOINS(?: DE)?|U|M)\s*(\d{1,2})(?!\d)/);
  if (age && AGES.includes(Number(age[1]))) return `-${age[1]}` as Categorie;
  if (/LOISIR/.test(n)) return "Loisir";
  if (
    /SENIOR|\bSM\b|\bSF\b|HONNEUR|EXCELLENCE|PRE.?NATIONAL|PRE.?REGION|NATIONAL|DIVISION|BUTAGAZ|STARLIGUE|PROLIGUE|COUPE DE FRANCE|\+ ?16/.test(n)
  ) {
    return "Seniors";
  }
  return "Autre";
}

/** Sexe déduit d'un libellé. `mixte` par défaut (compétitions sans mention). */
export function sexe(libelle: string): Sexe {
  const n = strip(libelle);
  if (/FEMININ|\bFEM\b|\bSF\b|\bF\b|(?:-|U|M)\s?\d{1,2}\s?F\b|BUTAGAZ/.test(n)) return "F";
  if (/MASCULIN|\bMASC\b|\bSM\b|\bM\b|(?:-|U|M)\s?\d{1,2}\s?M\b|STARLIGUE|PROLIGUE/.test(n)) return "M";
  return "mixte";
}

/**
 * Rang de l'équipe dans le club : chiffre final (« HBC 2 » → 2) ou lettre entre parenthèses
 * (« JDA DIJON HB (C) » → 3, A=1, B=2…). 1 par défaut.
 */
export function rang(nomEquipe: string): number {
  const n = strip(nomEquipe).trim();
  const lettre = n.match(/\(([A-F])\)\s*$/);
  if (lettre) return lettre[1]!.charCodeAt(0) - 64;
  const chiffre = n.match(/(?:\s|^)([1-9])\s*$/);
  return chiffre ? Number(chiffre[1]) : 1;
}

/** Entente ou convention entre clubs : « ENT BOUZONVILLE / BOULAY », « CONV. JDA / FONTAINE ». */
export function estEntente(nomEquipe: string): boolean {
  return /\b(?:ENT|ENTENTE|CONV|CONVENTION)\b/.test(strip(nomEquipe));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EquipeEntree {
  id_ffhb: string;
  nom: string;
  engagements: Array<{
    competition: { id_ffhb: string; nom: string; niveau: string | null };
    phase: { id_ffhb: string; nom: string };
    poule: { id_ffhb: string; nom: string };
  }>;
}

export interface GroupeEquipes<T extends EquipeEntree = EquipeEntree> {
  /** Clé stable du groupe : `-13|M|1|entente`. */
  cle: string;
  categorie: Categorie;
  sexe: Sexe;
  rang: number;
  entente: boolean;
  /** Libellé lisible : « -13 M — entente », « Seniors F (équipe 3) ». */
  libelle: string;
  equipes: T[];
  /** Compétitions distinctes auxquelles l'équipe réelle est inscrite. */
  competitions: Array<{ id_ffhb: string; nom: string; niveau: string | null }>;
}

const ORDRE_CATEGORIE: Categorie[] = ["Seniors", "-20", "-19", "-18", "-17", "-15", "-13", "-11", "-9", "-7", "Loisir", "Autre"];
const ORDRE_SEXE: Sexe[] = ["M", "F", "mixte"];

function libelle(cat: Categorie, sx: Sexe, rg: number, ent: boolean): string {
  const sexeTxt = sx === "mixte" ? "mixte" : sx;
  const base = cat === "Autre" ? "Autre" : `${cat} ${sexeTxt}`;
  return `${base}${rg > 1 ? ` (équipe ${rg})` : ""}${ent ? " — entente" : ""}`;
}

export function grouperEquipes<T extends EquipeEntree>(equipes: T[]): Array<GroupeEquipes<T>> {
  const groupes = new Map<string, GroupeEquipes<T>>();

  for (const eq of equipes) {
    const premiere = eq.engagements[0];
    const texteCompetition = premiere ? `${premiere.competition.nom} ${premiere.phase.nom}` : "";
    // Le nom de l'équipe ne sert que de repli quand la compétition ne dit rien (« U17M » dans le nom).
    let cat = categorie(texteCompetition);
    if (cat === "Autre") cat = categorie(eq.nom);
    let sx = sexe(texteCompetition);
    if (sx === "mixte") sx = sexe(eq.nom);
    const rg = rang(eq.nom);
    const ent = estEntente(eq.nom);
    const cle = `${cat}|${sx}|${rg}|${ent ? "entente" : "club"}`;

    let g = groupes.get(cle);
    if (!g) {
      g = { cle, categorie: cat, sexe: sx, rang: rg, entente: ent, libelle: libelle(cat, sx, rg, ent), equipes: [], competitions: [] };
      groupes.set(cle, g);
    }
    g.equipes.push(eq);
    for (const e of eq.engagements) {
      if (!g.competitions.some((c) => c.id_ffhb === e.competition.id_ffhb)) g.competitions.push(e.competition);
    }
  }

  return [...groupes.values()].sort(
    (a, b) =>
      ORDRE_CATEGORIE.indexOf(a.categorie) - ORDRE_CATEGORIE.indexOf(b.categorie) ||
      ORDRE_SEXE.indexOf(a.sexe) - ORDRE_SEXE.indexOf(b.sexe) ||
      a.rang - b.rang ||
      Number(a.entente) - Number(b.entente),
  );
}
