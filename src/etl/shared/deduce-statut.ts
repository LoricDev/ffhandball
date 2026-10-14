// src/etl/shared/deduce-statut.ts — statut d'un match déduit des scores de la source.

/**
 * Score attribué à l'équipe qui gagne par forfait (la perdante reste à NULL côté source).
 * Constaté sur 2026-2027 : 10 (jeunes) et 20 (autres). La source n'a pas de champ « forfait ».
 */
export const FORFAIT_WINNER_SCORES: ReadonlySet<number> = new Set([10, 20]);

export type StatutMatch = "a_jouer" | "joue" | "forfait";

/**
 * - deux scores         → joue
 * - un seul score 10/20 → forfait (le vainqueur a 10/20, le perdant n'a pas de score)
 * - sinon (aucun score, ou score isolé atypique) → a_jouer : le monitor continue de le signaler.
 */
export function deduceStatut(scoreDom: number | null | undefined, scoreExt: number | null | undefined): StatutMatch {
  const dom = scoreDom ?? null;
  const ext = scoreExt ?? null;
  if (dom !== null && ext !== null) return "joue";
  const seul = dom ?? ext;
  if (seul !== null && FORFAIT_WINNER_SCORES.has(seul)) return "forfait";
  return "a_jouer";
}
