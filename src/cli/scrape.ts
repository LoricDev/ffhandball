import { parseArgs } from "node:util";
import { logger } from "@/lib/logger.js";
import { closePool } from "@/db/client.js";
import { fetchHtml } from "@/scrapers/shared/http-client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";
import { parseClubDetail } from "@/scrapers/ffhandball/club-details.scraper.js";
import { parseClubSlugs } from "@/scrapers/ffhandball/club-slugs.scraper.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";

interface CliArgs {
  entity: string;
  saison: string;
  url?: string;
  limit?: number;
  slug?: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
      url: { type: "string" },
      limit: { type: "string" },
      slug: { type: "string" },
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

  return {
    entity: values.entity,
    saison: canonicalizeSaison(values.saison),
    url: values.url,
    limit,
    slug: values.slug,
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

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.entity === "clubs") {
    const url = args.url ?? "https://www.ffhandball.fr/clubs";
    await scrapeClubs(args.saison, url);
  } else if (args.entity === "club-details") {
    await scrapeClubDetails(args.saison, { limit: args.limit, slug: args.slug });
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
