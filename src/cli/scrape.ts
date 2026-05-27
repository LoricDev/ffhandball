import { parseArgs } from "node:util";
import * as cheerio from "cheerio";
import { logger } from "@/lib/logger.js";
import { closePool } from "@/db/client.js";
import { fetchHtml } from "@/scrapers/shared/http-client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
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

interface CliArgs {
  entity: string;
  saison: string;
  url?: string;
  limit?: number;
  slug?: string;
  level?: "national" | "regional" | "departemental";
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

  return {
    entity: values.entity,
    saison: canonicalizeSaison(values.saison),
    url: values.url,
    limit,
    slug: values.slug,
    level,
  };
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
    for (const slug of slugs) {
      const url = `https://monclub.ffhandball.fr/clubs/${slug}/`;
      const res = await fetchHtml(url);
      await run.incrementPages(1);

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
      { inserted_clubs, inserted_salles, no_salle, parse_failed },
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

    for (const niveau of levels) {
      const listUrl = `https://www.ffhandball.fr/competitions/saison-${saison}-${extSaisonId}/${niveau}/`;
      const listRes = await fetchHtml(listUrl);
      await run.incrementPages(1);

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
          const structRes = await fetchHtml(structUrl);
          await run.incrementPages(1);
          if (structRes.status >= 400) {
            logger.warn({ url: structUrl, status: structRes.status }, "per-structure page failed");
            continue;
          }
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
    let parseFailed = 0;
    for (const { ext_competition_id, detail_url } of competitions) {
      const res = await fetchHtml(detail_url);
      await run.incrementPages(1);
      if (res.status >= 400) {
        logger.warn({ detail_url, status: res.status }, "detail page failed");
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
    }

    logger.info(
      { totalCompetitions, insertedPhases, insertedPoules, parseFailed },
      "competitions scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "competitions scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.entity === "clubs") {
    const url = args.url ?? "https://www.ffhandball.fr/clubs";
    await scrapeClubs(args.saison, url);
  } else if (args.entity === "club-details") {
    await scrapeClubDetails(args.saison, { limit: args.limit, slug: args.slug });
  } else if (args.entity === "competitions") {
    await scrapeCompetitions(args.saison, {
      level: args.level,
      limit: args.limit,
    });
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
