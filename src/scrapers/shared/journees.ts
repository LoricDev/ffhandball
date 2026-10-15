// src/scrapers/shared/journees.ts — quelles journées d'une poule faut-il aller chercher EN PLUS de la page par défaut ?
//
// La page d'une poule n'affiche par défaut qu'UNE journée (la « courante » du site). Une journée jouée
// n'est donc capturée que si le scrape est passé pendant qu'elle était affichée : une poule découverte
// tard, ou un scrape manqué, laisse des journées jouées absentes de la base — et avec elles les feuilles de
// match, donc les liens par licence. Le mode « manquantes » comble ce trou sans re-télécharger l'existant.
import type { JourneeInfo } from "@/scrapers/ffhandball/rencontre-list.scraper.js";

export type JourneesMode = "all" | "courante" | "recent" | "manquantes";
export const JOURNEES_MODES: readonly JourneesMode[] = ["all", "courante", "recent", "manquantes"];

function startOfDayMs(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Journées à fetcher EN PLUS de la page courante, selon le mode :
 *  - "courante"   : aucune (seule la page par défaut, déjà récupérée).
 *  - "all"        : toutes les journées DÉJÀ jouées (on saute les journées futures : aucun match à
 *                   récupérer, et ce sont autant de hits non-cachés qui font basculer le WAF).
 *  - "recent"     : seulement les journées jouées dans la fenêtre glissante des N derniers jours.
 *  - "manquantes" : les journées déjà commencées qui ne sont PAS dans `completes` (absentes de la base,
 *                   ou dont un match est resté « à jouer » alors que sa date est passée).
 * La journée déjà couverte par la page courante est toujours exclue.
 */
export function journeesToFetch(
  mode: JourneesMode,
  journees: JourneeInfo[],
  alreadyFetched: number | undefined,
  now: Date,
  opts: { recentDays: number; completes?: ReadonlySet<number> },
): number[] {
  if (mode === "courante") return [];
  const todayMs = startOfDayMs(now);
  const recentFromMs = todayMs - opts.recentDays * 86_400_000;
  const picked: number[] = [];
  for (const j of journees) {
    if (j.numero === alreadyFetched) continue;
    const debutMs = j.date_debut ? Date.parse(`${j.date_debut}T00:00:00`) : NaN;
    const finMs = j.date_fin ? Date.parse(`${j.date_fin}T23:59:59`) : debutMs;
    // Saute les journées futures (date de début > aujourd'hui) : pas encore jouées.
    if (Number.isFinite(debutMs) && debutMs > todayMs) continue;
    if (mode === "manquantes") {
      // Sans date exploitable on ne peut pas affirmer que la journée est passée : on s'abstient.
      if (!Number.isFinite(debutMs)) continue;
      if (opts.completes?.has(j.numero)) continue;
    } else if (mode === "recent") {
      const refMs = Number.isFinite(finMs) ? finMs : debutMs;
      // Sans date exploitable, on ne peut pas confirmer « récent » → on n'ajoute pas (la page
      // courante couvre déjà la journée en cours).
      if (!Number.isFinite(refMs) || refMs < recentFromMs) continue;
    }
    picked.push(j.numero);
  }
  return picked;
}
