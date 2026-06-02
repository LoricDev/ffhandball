// src/scrapers/shared/date-window.ts
// Fenêtre temporelle [from, to[ pour cibler un sous-ensemble de matchs/poules
// (ex. les matchs d'un week-end), en heure locale du serveur.

export interface DateWindow {
  from: Date;
  to: Date;
}

/**
 * Week-end de la semaine ISO courante : du samedi 00:00 au lundi 00:00 (couvre samedi
 * et dimanche), en heure locale. Pour un run un dimanche, renvoie bien le samedi/dimanche
 * en cours ; pour un run en semaine, renvoie le week-end à venir de la même semaine ISO.
 */
export function weekendWindow(now: Date): DateWindow {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  // Jour de la semaine ISO : 0 = lundi … 6 = dimanche.
  const isoDow = (from.getDay() + 6) % 7;
  // Samedi de la semaine ISO courante = lundi + 5 jours.
  from.setDate(from.getDate() - isoDow + 5);
  const to = new Date(from);
  to.setDate(from.getDate() + 2); // samedi + 2 = lundi 00:00 → couvre sam. et dim.
  return { from, to };
}

/** Parse `YYYY-MM-DD` (minuit local) ou un ISO 8601 complet. */
export function parseDate(input: string): Date {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00` : input);
  if (Number.isNaN(d.getTime())) throw new Error(`Date invalide : ${input}`);
  return d;
}

/**
 * Résout la fenêtre à partir des arguments CLI : `--from`/`--to` explicites sinon `--weekend`.
 * Renvoie `null` si aucun filtre temporel n'est demandé.
 */
export function resolveDateWindow(
  opts: { from?: string; to?: string; weekend?: boolean },
  now: Date,
): DateWindow | null {
  if (opts.from || opts.to) {
    const from = opts.from ? parseDate(opts.from) : new Date(0);
    const to = opts.to ? parseDate(opts.to) : new Date(8.64e15); // ~max Date
    if (to <= from) throw new Error(`Fenêtre invalide : --to (${opts.to}) doit suivre --from (${opts.from})`);
    return { from, to };
  }
  if (opts.weekend) return weekendWindow(now);
  return null;
}
