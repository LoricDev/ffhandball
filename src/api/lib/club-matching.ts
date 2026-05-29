// src/api/lib/club-matching.ts
export type MatchMethod = "licence" | "structure" | "nom_exact" | "nom_reserve" | "nom_entente";
export type Confidence = "haute" | "moyenne" | "basse";

/** Seuil de licenciés distincts du club requis pour lier une équipe via composition. */
export const LICENCE_MATCH_MIN_PLAYERS = 3;

/** Mots structurels génériques (≥ 4 chars) exclus des tokens distinctifs. */
export const STOPWORDS = new Set<string>([
  "handball",
  "club",
  "association",
  "asso",
  "sport",
  "sports",
  "sporting",
  "sportif",
  "sportive",
  "sportives",
  "omnisports",
  "omnisport",
  "asptt",
  "elan",
  "avenir",
  "jeune",
  "jeunes",
  "jeunesse",
  "etoile",
  "union",
  "amicale",
  "foyer",
  "groupe",
  "groupement",
  "entente",
  "olympique",
  "olympic",
]);

/** Tokens ≥ 4 chars, non-STOPWORD, non purement numériques, accents retirés, dédupliqués. */
export function extractDistinctiveTokens(nom: string): string[] {
  const tokens = nom
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !/^\d+$/.test(t));
  return [...new Set(tokens)];
}

/** Motif Postgres regex mot-entier `\m(a|b)\M`, ou null si aucun token. */
export function buildWholeWordPattern(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return `\\m(${tokens.join("|")})\\M`;
}

export const RANK_BY_CONFIDENCE: Record<Confidence, number> = { haute: 3, moyenne: 2, basse: 1 };

export function rankToConfidence(rank: number): Confidence {
  return rank >= 3 ? "haute" : rank === 2 ? "moyenne" : "basse";
}

/**
 * Extrait le code FFHB 7 chiffres du club depuis son email (`5221105@ffhandball.net` → `5221105`).
 * Ce code = préfixe des numéros de licence (clé de la couche `licence`). Distinct de `clubs.id_ffhb`
 * (= id_club monclub). Retourne null si l'email est absent ou si le préfixe n'est pas 7 chiffres.
 */
export function code7FromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const prefix = email.split("@")[0] ?? "";
  return /^\d{7}$/.test(prefix) ? prefix : null;
}
