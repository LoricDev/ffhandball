// src/api/lib/dates.ts — sérialisation des dates en sortie d'API.

/**
 * Jour calendaire YYYY-MM-DD. Le driver pg renvoie une Date à minuit *local* pour une colonne `date` :
 * `toISOString()` décalerait d'un jour dans un fuseau à l'est d'UTC, d'où les getters locaux.
 */
export function toDayString(v: Date | string): string {
  if (typeof v === "string") return v.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

/** Date-heure ISO 8601 (colonnes timestamptz). */
export function toIsoString(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}
