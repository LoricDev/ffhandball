// src/lib/saison.ts — saison courante, calculée (plus aucune valeur codée en dur).
//
// La saison de handball commence le 1er juillet : 2026-07-01 → 2027-06-30 = « 2026-2027 ».
// Même règle que deploy/cron/lib-saison.sh (les crons scrapent cette saison-là), en UTC comme le serveur.

export function currentSaison(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const start = month >= 7 ? year : year - 1;
  return `${start}-${start + 1}`;
}
