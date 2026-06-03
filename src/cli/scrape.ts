import { parseArgs } from "node:util";
import * as cheerio from "cheerio";
import { logger } from "@/lib/logger.js";
import { env } from "@/config/env.js";
import { closePool, query } from "@/db/client.js";
import { fetchHtml, fetchBinary } from "@/scrapers/shared/http-client.js";
import { forEachConcurrent } from "@/scrapers/shared/concurrency.js";
import { startScrapeRun, type ScrapeRunHandle } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";
import { parseClubDetail } from "@/scrapers/ffhandball/club-details.scraper.js";
import { parseClubSlugs } from "@/scrapers/ffhandball/club-slugs.scraper.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import {
  parseCompetitionList,
  parseStructures,
  slugifyLibelle,
} from "@/scrapers/ffhandball/competition-list.scraper.js";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";
import { parseRencontreList } from "@/scrapers/ffhandball/rencontre-list.scraper.js";
import { parseClassement } from "@/scrapers/ffhandball/classement.scraper.js";
import { resolveDateWindow, type DateWindow } from "@/scrapers/shared/date-window.js";
import { parseStatsJoueurs } from "@/scrapers/ffhandball/stats-joueurs.scraper.js";
import { parseFdmPdf } from "@/scrapers/ffhandball/fdm-pdf.parser.js";

interface CliArgs {
  entity: string;
  saison: string;
  url?: string;
  limit?: number;
  slug?: string;
  level?: "national" | "regional" | "departemental";
  journees?: "all" | "courante";
  window: DateWindow | null;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
      url: { type: "string" },
      limit: { type: "string" },
      slug: { type: "string" },
      level: { type: "string" },
      journees: { type: "string" },
      // Scoping temporel (matchs/classements) : ne scraper que les poules qui jouent.
      live: { type: "boolean" },     // matchs en cours/imminents (now−2h … now+30min)
      weekend: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
      days: { type: "string" },      // fenêtre [now−N jours, now] (ex. backfill FdM récentes)
      // feuilles-match : accepté mais sans effet — les matchs joués (< aujourd'hui) sont le défaut.
      played: { type: "boolean" },
    },
  });
  if (!values.entity) throw new Error("--entity required");
  if (!values.saison) throw new Error("--saison required");

  let limit: number | undefined;
  if (values.limit !== undefined) {
    const n = Number.parseInt(values.limit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got ${values.limit}`);
    }
    limit = n;
  }

  let level: "national" | "regional" | "departemental" | undefined;
  if (values.level !== undefined) {
    const validLevels = ["national", "regional", "departemental"] as const;
    if (!validLevels.includes(values.level as (typeof validLevels)[number])) {
      throw new Error(`--level must be one of national|regional|departemental, got ${values.level}`);
    }
    level = values.level as "national" | "regional" | "departemental";
  }

  let journees: "all" | "courante" | undefined;
  if (values.journees !== undefined) {
    if (values.journees !== "all" && values.journees !== "courante") {
      throw new Error(`Invalid --journees value: ${values.journees}. Use 'all' or 'courante'.`);
    }
    journees = values.journees as "all" | "courante";
  }

  let recentDays: number | undefined;
  if (values.days !== undefined) {
    const n = Number.parseInt(values.days, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--days doit être un entier positif, reçu ${values.days}`);
    recentDays = n;
  }

  const window = resolveDateWindow(
    {
      from: values.from,
      to: values.to,
      weekend: values.weekend === true,
      live: values.live === true,
      recentDays,
    },
    new Date(),
  );

  return {
    entity: values.entity,
    saison: canonicalizeSaison(values.saison),
    url: values.url,
    limit,
    slug: values.slug,
    level,
    journees,
    window,
  };
}

/**
 * Fetch HTML "tolérant" : incrémente le compteur de pages et, en cas d'échec HTTP
 * persistant (après les retries), logue un warning et renvoie null au lieu de lever
 * une exception. Permet de sauter une page fautive (ex: 500 ffhandball.fr sur une
 * compétition précise) sans faire échouer tout le run.
 */
async function tryFetchHtml(
  run: ScrapeRunHandle,
  url: string,
): Promise<Awaited<ReturnType<typeof fetchHtml>> | null> {
  try {
    const res = await fetchHtml(url);
    await run.incrementPages(1);
    return res;
  } catch (err) {
    await run.incrementPages(1);
    logger.warn({ url, err: String(err) }, "page fetch failed after retries, skipping");
    return null;
  }
}

async function scrapeClubs(saison: string, url: string): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "clubs",
    saison,
  });
  logger.info({ run_id: run.id, url }, "starting clubs scrape");

  try {
    const res = await fetchHtml(url);
    await run.incrementPages(1);
    const clubs = parseClubsListing(res.body, res.url);
    logger.info({ count: clubs.length }, "parsed clubs");

    let inserted = 0;
    let duplicates = 0;
    for (const club of clubs) {
      const { inserted: wasNew } = await insertRaw("clubs", {
        scrape_run_id: run.id,
        source_url: club.source_url,
        source_site: "ffhandball.fr",
        natural_key: club.id_ffhb,
        payload: club,
        saison,
        http_status: res.status,
      });
      if (wasNew) inserted++;
      else duplicates++;
    }
    logger.info({ inserted, duplicates }, "raw inserts done");
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

async function scrapeClubDetails(
  saison: string,
  opts: { limit?: number; slug?: string },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "monclub.ffhandball.fr",
    scraper_name: "club-details",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting club-details scrape");

  try {
    // 1. Determine slug list
    let slugs: string[];
    if (opts.slug) {
      slugs = [opts.slug];
    } else {
      const homeRes = await fetchHtml("https://monclub.ffhandball.fr/");
      await run.incrementPages(1);
      slugs = parseClubSlugs(homeRes.body);
      if (opts.limit !== undefined) slugs = slugs.slice(0, opts.limit);
    }
    logger.info({ count: slugs.length }, "slugs to process");

    // 2. Iterate
    let inserted_clubs = 0;
    let inserted_salles = 0;
    let no_salle = 0;
    let parse_failed = 0;
    let fetch_failed = 0;
    for (const slug of slugs) {
      const url = `https://monclub.ffhandball.fr/clubs/${slug}/`;
      const res = await tryFetchHtml(run, url);
      if (res === null) {
        fetch_failed++;
        continue;
      }

      const parsed = parseClubDetail(res.body, res.url);
      if (!parsed) {
        parse_failed++;
        logger.warn({ slug, url }, "parseClubDetail returned null");
        continue;
      }

      await insertRaw("clubs", {
        scrape_run_id: run.id,
        source_url: parsed.club.source_url,
        source_site: "monclub.ffhandball.fr",
        natural_key: parsed.club.id_ffhb,
        payload: parsed.club,
        saison,
        http_status: res.status,
      });
      inserted_clubs++;

      if (parsed.salle) {
        await insertRaw("salles", {
          scrape_run_id: run.id,
          source_url: parsed.salle.source_url,
          source_site: "monclub.ffhandball.fr",
          natural_key: parsed.salle.id_ffhb,
          payload: parsed.salle,
          saison,
          http_status: res.status,
        });
        inserted_salles++;
      } else {
        no_salle++;
      }
    }
    logger.info(
      { inserted_clubs, inserted_salles, no_salle, parse_failed, fetch_failed },
      "club-details scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "club-details scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

function extractExtSaisonId(html: string, saisonCode: string): string | null {
  // Le composant `competitions---saison-selector` contient toutes les saisons.
  // T1 a confirmé que le libellé y est "2025 - 2026" (avec espaces autour du tiret).
  // On normalise en retirant les espaces pour matcher saisonCode "2025-2026".
  const $ = cheerio.load(html);
  const el = $("smartfire-component[name='competitions---saison-selector']").first();
  const raw = el.attr("attributes");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as {
      saisons?: Array<{ libelle?: string; ext_saisonId?: string }>;
    };
    if (!Array.isArray(data.saisons)) return null;
    const norm = (s: string): string => s.replace(/\s+/g, "");
    const match = data.saisons.find(
      (s) => typeof s.libelle === "string" && norm(s.libelle) === norm(saisonCode),
    );
    return match?.ext_saisonId ?? null;
  } catch {
    return null;
  }
}

async function scrapeCompetitions(
  saison: string,
  opts: { level?: "national" | "regional" | "departemental"; limit?: number },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "competitions",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting competitions scrape");

  try {
    // 1. Resolve ext_saison_id from /competitions/ home
    const homeRes = await fetchHtml("https://www.ffhandball.fr/competitions/");
    await run.incrementPages(1);
    const extSaisonId = extractExtSaisonId(homeRes.body, saison);
    if (!extSaisonId) {
      throw new Error(`ext_saison_id introuvable pour saison=${saison}`);
    }
    logger.info({ ext_saison_id: extSaisonId }, "resolved ext_saison_id");

    const levels: Array<"national" | "regional" | "departemental"> = opts.level
      ? [opts.level]
      : ["national", "regional", "departemental"];

    // 2. Passe A — listes par niveau
    let totalCompetitions = 0;
    const competitionsToDetail: Array<{
      ext_competition_id: string;
      detail_url: string;
    }> = [];

    let listSkipped = 0;
    for (const niveau of levels) {
      const listUrl = `https://www.ffhandball.fr/competitions/saison-${saison}-${extSaisonId}/${niveau}/`;
      const listRes = await tryFetchHtml(run, listUrl);
      if (!listRes) {
        listSkipped++;
        logger.warn({ url: listUrl, niveau }, "liste par niveau injoignable, niveau sauté");
        continue;
      }

      if (niveau === "national") {
        const comps = parseCompetitionList(listRes.body, "national", listUrl, saison, extSaisonId);
        for (const c of comps) {
          await insertRaw("competitions", {
            scrape_run_id: run.id,
            source_url: c.source_url,
            source_site: "ffhandball.fr",
            natural_key: c.ext_competition_id,
            payload: c,
            saison,
            http_status: listRes.status,
          });
          competitionsToDetail.push({
            ext_competition_id: c.ext_competition_id,
            detail_url: c.detail_url,
          });
          totalCompetitions++;
        }
      } else {
        const structures = parseStructures(listRes.body);
        for (const s of structures) {
          // T1 a découvert que les URLs per-structure nécessitent le préfixe "o-"
          // Pattern : /<niveau>/o-{slug(libelle)}-{ext_structure_id}/
          const structUrl = `https://www.ffhandball.fr/competitions/saison-${saison}-${extSaisonId}/${niveau}/o-${slugifyLibelle(s.libelle)}-${s.ext_structure_id}/`;
          const structRes = await tryFetchHtml(run, structUrl);
          if (!structRes) continue;
          const comps = parseCompetitionList(
            structRes.body,
            niveau,
            structUrl,
            saison,
            extSaisonId,
          );
          for (const c of comps) {
            await insertRaw("competitions", {
              scrape_run_id: run.id,
              source_url: c.source_url,
              source_site: "ffhandball.fr",
              natural_key: c.ext_competition_id,
              payload: c,
              saison,
              http_status: structRes.status,
            });
            competitionsToDetail.push({
              ext_competition_id: c.ext_competition_id,
              detail_url: c.detail_url,
            });
            totalCompetitions++;
          }
        }
      }
    }
    logger.info({ totalCompetitions }, "passe A done");

    // 3. Passe B — détails (phases + poules)
    let competitions = competitionsToDetail;
    if (opts.limit !== undefined) competitions = competitions.slice(0, opts.limit);

    let insertedPhases = 0;
    let insertedPoules = 0;
    let insertedEquipes = 0;
    let insertedEngagements = 0;
    let parseFailed = 0;
    let detailSkipped = 0;
    for (const { ext_competition_id, detail_url } of competitions) {
      const res = await tryFetchHtml(run, detail_url);
      if (!res) {
        detailSkipped++;
        continue;
      }
      const parsed = parseCompetitionDetail(res.body, detail_url, ext_competition_id);
      if (!parsed) {
        parseFailed++;
        logger.warn({ ext_competition_id }, "parseCompetitionDetail returned null");
        continue;
      }
      for (const ph of parsed.phases) {
        await insertRaw("phases", {
          scrape_run_id: run.id,
          source_url: ph.source_url,
          source_site: "ffhandball.fr",
          natural_key: ph.ext_phase_id,
          payload: ph,
          saison,
          http_status: res.status,
        });
        insertedPhases++;
      }
      for (const po of parsed.poules) {
        await insertRaw("poules", {
          scrape_run_id: run.id,
          source_url: po.source_url,
          source_site: "ffhandball.fr",
          natural_key: po.ext_poule_id,
          payload: po,
          saison,
          http_status: res.status,
        });
        insertedPoules++;
      }
      for (const eq of parsed.equipes) {
        await insertRaw("equipes", {
          scrape_run_id: run.id,
          source_url: eq.source_url,
          source_site: "ffhandball.fr",
          natural_key: eq.ext_equipe_id,
          payload: eq,
          saison,
          http_status: res.status,
        });
        insertedEquipes++;
      }
      for (const en of parsed.engagements) {
        await insertRaw("engagements", {
          scrape_run_id: run.id,
          source_url: en.source_url,
          source_site: "ffhandball.fr",
          natural_key: `${en.ext_equipe_id}-${en.ext_poule_id}`,
          payload: en,
          saison,
          http_status: res.status,
        });
        insertedEngagements++;
      }
    }

    logger.info(
      { totalCompetitions, insertedPhases, insertedPoules, insertedEquipes, insertedEngagements, parseFailed, listSkipped, detailSkipped },
      "competitions scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "competitions scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

interface ScrapablePoule {
  ext_poule_id: string;
  ext_competition_id: string;
  niveau: string;
  detail_url: string;
}

/**
 * Poules scrapables d'une saison (filtrables par niveau). Si `window` est fourni, ne
 * retient que les poules ayant au moins un match dans la fenêtre [from, to[ — base du
 * scraping ciblé « week-end » (réduit 12k poules à celles qui jouent réellement).
 */
async function selectScrapablePoules(
  saison: string,
  level: string | undefined,
  window: DateWindow | null,
): Promise<ScrapablePoule[]> {
  const windowFilter = window
    ? ` AND EXISTS (
           SELECT 1 FROM core.matchs m
            WHERE m.poule_id = po.id
              AND m.date_heure >= $3 AND m.date_heure < $4
         )`
    : "";
  const params: unknown[] = [saison, level ?? null];
  if (window) params.push(window.from, window.to);

  const res = await query<ScrapablePoule>(
    `SELECT po.id_ffhb AS ext_poule_id,
            c.id_ffhb  AS ext_competition_id,
            c.niveau,
            c.detail_url
       FROM core.poules po
       JOIN core.phases ph       ON ph.id = po.phase_id
       JOIN core.competitions c  ON c.id = ph.competition_id
      WHERE po.saison_code = $1
        AND ($2::text IS NULL OR c.niveau = $2)
        AND c.detail_url IS NOT NULL${windowFilter}
      ORDER BY c.niveau, c.id_ffhb, po.id_ffhb`,
    params,
  );
  return res.rows;
}

async function scrapeMatchs(
  saison: string,
  opts: {
    level?: "national" | "regional" | "departemental";
    journees?: "all" | "courante";
    limit?: number;
    window?: DateWindow | null;
  },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "matchs",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting matchs scrape");

  try {
    // 1. SELECT poules from core (with their competition's detail_url + niveau)
    let poules = await selectScrapablePoules(saison, opts.level, opts.window ?? null);
    if (opts.limit !== undefined) poules = poules.slice(0, opts.limit);
    logger.info({ count: poules.length, windowed: Boolean(opts.window) }, "poules to process");

    let totalInserted = 0;
    let pouleSkipped = 0;
    const mode = opts.journees ?? "courante";

    // Poules traitées en parallèle (au plus SCRAPE_CONCURRENCY en vol). Le rate-limit reste
    // un plancher global par domaine — la concurrence masque la latence d'insertion sans
    // dépasser le plancher. Les compteurs sont incrémentés de façon synchrone (sûr).
    await forEachConcurrent(poules, env.SCRAPE_CONCURRENCY, async (po) => {
      const baseUrl = `${po.detail_url}poule-${po.ext_poule_id}/`;

      // First fetch : journée courante (no query param)
      const res = await tryFetchHtml(run, baseUrl);
      if (res === null) {
        pouleSkipped++;
        return;
      }
      const parsed = parseRencontreList(res.body, baseUrl, po.ext_poule_id);
      if (!parsed) {
        logger.warn({ url: baseUrl }, "parseRencontreList returned null");
        pouleSkipped++;
        return;
      }

      const journeeAlreadyFetched = parsed.matchs[0]?.journee;
      for (const m of parsed.matchs) {
        await insertRaw("matchs", {
          scrape_run_id: run.id,
          source_url: m.source_url,
          source_site: "ffhandball.fr",
          natural_key: m.ext_rencontre_id,
          payload: m,
          saison,
          http_status: res.status,
        });
        totalInserted++;
      }

      // Équipes + engagements de la poule (source complète depuis equipe_options) : garantit
      // que toute équipe référencée par un match est en base. Capturé une fois par poule.
      for (const eq of parsed.equipes) {
        await insertRaw("equipes", {
          scrape_run_id: run.id,
          source_url: eq.source_url,
          source_site: "ffhandball.fr",
          natural_key: eq.ext_equipe_id,
          payload: eq,
          saison,
          http_status: res.status,
        });
      }
      for (const en of parsed.engagements) {
        await insertRaw("engagements", {
          scrape_run_id: run.id,
          source_url: en.source_url,
          source_site: "ffhandball.fr",
          natural_key: `${en.ext_equipe_id}-${en.ext_poule_id}`,
          payload: en,
          saison,
          http_status: res.status,
        });
      }

      // If --journees=all, iterate over remaining journées
      if (mode === "all" && parsed.journees_disponibles.length > 0) {
        const remaining = parsed.journees_disponibles.filter(
          (j) => j !== journeeAlreadyFetched,
        );
        for (const j of remaining) {
          const jUrl = `${baseUrl}?numero_journee=${j}`;
          const jRes = await tryFetchHtml(run, jUrl);
          if (jRes === null) continue;
          const jParsed = parseRencontreList(jRes.body, jUrl, po.ext_poule_id);
          if (!jParsed) continue;
          for (const m of jParsed.matchs) {
            await insertRaw("matchs", {
              scrape_run_id: run.id,
              source_url: m.source_url,
              source_site: "ffhandball.fr",
              natural_key: m.ext_rencontre_id,
              payload: m,
              saison,
              http_status: jRes.status,
            });
            totalInserted++;
          }
        }
      }
    });

    logger.info(
      { totalInserted, pouleSkipped, mode, concurrency: env.SCRAPE_CONCURRENCY },
      "matchs scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "matchs scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

async function scrapeClassements(
  saison: string,
  opts: {
    level?: "national" | "regional" | "departemental";
    limit?: number;
    window?: DateWindow | null;
  },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "classements",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting classements scrape");

  try {
    let poules = await selectScrapablePoules(saison, opts.level, opts.window ?? null);
    if (opts.limit !== undefined) poules = poules.slice(0, opts.limit);
    logger.info({ count: poules.length, windowed: Boolean(opts.window) }, "poules to process");

    let totalInserted = 0;
    let pouleSkipped = 0;
    let pouleVide = 0;

    await forEachConcurrent(poules, env.SCRAPE_CONCURRENCY, async (po) => {
      const url = `${po.detail_url}poule-${po.ext_poule_id}/classements/`;
      const res = await tryFetchHtml(run, url);
      if (res === null) {
        pouleSkipped++;
        return;
      }
      const parsed = parseClassement(res.body, url, po.ext_poule_id);
      if (parsed === null) {
        logger.warn({ url }, "parseClassement returned null");
        pouleSkipped++;
        return;
      }
      if (parsed.length === 0) {
        pouleVide++;
        return;
      }
      for (const c of parsed) {
        await insertRaw("classements", {
          scrape_run_id: run.id,
          source_url: c.source_url,
          source_site: "ffhandball.fr",
          natural_key: c.ext_classement_id,
          payload: c,
          saison,
          http_status: res.status,
        });
        totalInserted++;
      }
    });

    logger.info(
      { totalInserted, pouleSkipped, pouleVide, totalPoules: poules.length, concurrency: env.SCRAPE_CONCURRENCY },
      "classements scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "classements scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

async function scrapeStatsJoueurs(
  saison: string,
  opts: { limit?: number },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "stats-joueurs",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting stats-joueurs scrape");

  try {
    // Filtre afficher_stats_joueurs=true en amont (national + régional séniors)
    const poulesRes = await query<{
      ext_poule_id: string;
      detail_url: string;
    }>(
      `SELECT po.id_ffhb AS ext_poule_id, c.detail_url
         FROM core.poules po
         JOIN core.phases ph       ON ph.id = po.phase_id
         JOIN core.competitions c  ON c.id = ph.competition_id
        WHERE po.saison_code = $1
          AND c.afficher_stats_joueurs = true
          AND c.detail_url IS NOT NULL
        ORDER BY c.id_ffhb, po.id_ffhb`,
      [saison],
    );

    let poules = poulesRes.rows;
    if (opts.limit !== undefined) poules = poules.slice(0, opts.limit);
    logger.info({ count: poules.length }, "poules with stats to process");

    let totalInserted = 0;
    let pouleSansStats = 0;
    let pouleSkipped = 0;

    for (const po of poules) {
      const url = `${po.detail_url}poule-${po.ext_poule_id}/statistiques/`;
      const res = await tryFetchHtml(run, url);
      if (res === null) {
        pouleSkipped++;
        continue;
      }
      const parsed = parseStatsJoueurs(res.body, url, po.ext_poule_id);
      if (parsed.length === 0) {
        pouleSansStats++;
        continue;
      }
      for (const s of parsed) {
        await insertRaw("stats_joueurs", {
          scrape_run_id: run.id,
          source_url: s.source_url,
          source_site: "ffhandball.fr",
          natural_key: `${s.ext_poule_id}-${s.individu_id}`,
          payload: s,
          saison,
          http_status: res.status,
        });
        totalInserted++;
      }
    }
    logger.info(
      { totalInserted, pouleSansStats, pouleSkipped, totalPoules: poules.length },
      "stats-joueurs scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "stats-joueurs scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

async function scrapeFeuillesMatch(
  saison: string,
  opts: { limit?: number; window?: DateWindow | null },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "media-ffhb-fdm.ffhandball.fr",
    scraper_name: "feuilles-match",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting feuilles-match scrape");

  try {
    // 1. Codes FdM à scraper : matchs DÉJÀ JOUÉS uniquement (date_heure < now), non encore
    //    capturés. Les matchs À VENIR n'ont jamais de FdM → toujours exclus (zéro 404 inutile).
    //    Sans fenêtre : toute la saison jusqu'à aujourd'hui (rattrapage complet). --days borne
    //    en plus aux N derniers jours (passages quotidiens). Le filtre NOT EXISTS + la dédup
    //    payload_hash font qu'un re-run rattrape les FdM publiées en retard sans re-télécharger.
    const params: unknown[] = [saison];
    let windowFilter = "";
    if (opts.window) {
      params.push(opts.window.from, opts.window.to);
      windowFilter = ` AND m.date_heure >= $2 AND m.date_heure < $3`;
    }
    const codesRes = await query<{ fdm_code: string }>(
      `SELECT DISTINCT m.fdm_code
         FROM core.matchs m
         JOIN core.poules po ON po.id = m.poule_id
        WHERE po.saison_code = $1
          AND m.fdm_code IS NOT NULL AND m.fdm_code <> ''
          AND m.date_heure < now()${windowFilter}
          AND NOT EXISTS (
            SELECT 1 FROM raw.feuilles_match fm
            WHERE fm.natural_key = m.fdm_code AND fm.saison = $1
          )
        ORDER BY m.fdm_code`,
      params,
    );

    let toProcess = codesRes.rows;
    if (opts.limit !== undefined) toProcess = toProcess.slice(0, opts.limit);
    logger.info({ count: toProcess.length }, "fdm codes to process");

    let totalSuccess = 0;
    let total404 = 0;
    let parseFail = 0;

    for (const { fdm_code } of toProcess) {
      if (fdm_code.length < 4) {
        logger.warn({ fdm_code }, "fdm_code too short, skip");
        continue;
      }
      const url = `https://media-ffhb-fdm.ffhandball.fr/fdm/${fdm_code[0]}/${fdm_code[1]}/${fdm_code[2]}/${fdm_code[3]}/${fdm_code}.pdf`;
      const res = await fetchBinary(url);
      await run.incrementPages(1);

      if (res.status === 404) {
        total404++;
        continue;
      }
      if (res.status >= 400) {
        logger.warn({ url, status: res.status }, "FdM fetch failed");
        continue;
      }

      const parsed = await parseFdmPdf(res.body, url, fdm_code);
      if (!parsed) {
        parseFail++;
        continue;
      }

      await insertRaw("feuilles_match", {
        scrape_run_id: run.id,
        source_url: url,
        source_site: "media-ffhb-fdm.ffhandball.fr",
        natural_key: fdm_code,
        payload: parsed,
        saison,
        http_status: res.status,
      });
      totalSuccess++;
    }

    logger.info({ totalSuccess, total404, parseFail, totalProcessed: toProcess.length }, "feuilles-match scrape done");
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "feuilles-match scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.entity === "clubs") {
    const url = args.url ?? "https://monclub.ffhandball.fr";
    await scrapeClubs(args.saison, url);
  } else if (args.entity === "club-details") {
    await scrapeClubDetails(args.saison, { limit: args.limit, slug: args.slug });
  } else if (args.entity === "competitions") {
    await scrapeCompetitions(args.saison, {
      level: args.level,
      limit: args.limit,
    });
  } else if (args.entity === "matchs") {
    await scrapeMatchs(args.saison, {
      level: args.level as "national" | "regional" | "departemental" | undefined,
      journees: args.journees as "all" | "courante" | undefined,
      limit: args.limit,
      window: args.window,
    });
  } else if (args.entity === "classements") {
    await scrapeClassements(args.saison, {
      level: args.level as "national" | "regional" | "departemental" | undefined,
      limit: args.limit,
      window: args.window,
    });
  } else if (args.entity === "stats-joueurs") {
    await scrapeStatsJoueurs(args.saison, { limit: args.limit });
  } else if (args.entity === "feuilles-match") {
    await scrapeFeuillesMatch(args.saison, { limit: args.limit, window: args.window });
  } else {
    throw new Error(`unknown entity: ${args.entity}`);
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    logger.fatal({ err }, "fatal");
    await closePool();
    process.exit(1);
  });
