import { parseArgs } from "node:util";
import { logger } from "@/lib/logger.js";
import { closePool } from "@/db/client.js";
import { fetchHtml } from "@/scrapers/shared/http-client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";

interface CliArgs {
  entity: string;
  saison: string;
  url?: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
      url: { type: "string" },
    },
  });
  if (!values.entity) throw new Error("--entity required");
  if (!values.saison) throw new Error("--saison required");
  return {
    entity: values.entity,
    saison: canonicalizeSaison(values.saison),
    url: values.url,
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

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.entity !== "clubs") {
    throw new Error(`unknown entity: ${args.entity} (only 'clubs' implemented in pilot)`);
  }
  const url = args.url ?? "https://www.ffhandball.fr/clubs";
  await scrapeClubs(args.saison, url);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    logger.fatal({ err }, "fatal");
    await closePool();
    process.exit(1);
  });
