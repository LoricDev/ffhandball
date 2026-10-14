// src/etl/shared/deduce-statut.ts — statut / forfait d'un match déduits du payload de la source.

/**
 * Repli pour les anciennes captures raw (sans marqueur « FO » conservé) : sur la source, l'équipe
 * qui gagne par forfait a 10 (jeunes) ou 20 (autres) et l'équipe forfait n'a pas de score.
 */
export const FORFAIT_WINNER_SCORES: ReadonlySet<number> = new Set([10, 20]);

export type StatutMatch = "a_jouer" | "joue" | "forfait";
export type CoteForfait = "dom" | "ext";

export interface ScoreInfo {
  score_dom?: number | null;
  score_ext?: number | null;
  /** Score affiché « FO » pour l'équipe domicile / extérieur (marqueur explicite de la source). */
  forfait_dom?: boolean;
  forfait_ext?: boolean;
}

/** Équipe forfait : marqueur « FO » explicite, sinon repli sur un score isolé de 10/20. */
export function deduceForfait(p: ScoreInfo): CoteForfait | null {
  if (p.forfait_dom) return "dom";
  if (p.forfait_ext) return "ext";
  const dom = p.score_dom ?? null;
  const ext = p.score_ext ?? null;
  if (dom !== null && ext === null && FORFAIT_WINNER_SCORES.has(dom)) return "ext";
  if (ext !== null && dom === null && FORFAIT_WINNER_SCORES.has(ext)) return "dom";
  return null;
}

/**
 * - forfait (FO, ou repli)      → forfait
 * - deux scores                 → joue
 * - sinon (aucun score, ou score isolé atypique) → a_jouer : le monitor continue de le signaler.
 */
export function deduceStatut(p: ScoreInfo): StatutMatch {
  if (deduceForfait(p)) return "forfait";
  return (p.score_dom ?? null) !== null && (p.score_ext ?? null) !== null ? "joue" : "a_jouer";
}
