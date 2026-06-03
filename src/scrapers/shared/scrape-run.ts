import { query } from "@/db/client.js";

export interface ScrapeRunInput {
  source_site: string;
  scraper_name: string;
  saison: string;
}

export interface ScrapeRunHandle {
  id: string;
  setTotal(n: number): Promise<void>;
  incrementPages(n?: number): Promise<void>;
  finishSuccess(): Promise<void>;
  finishFailure(error: unknown): Promise<void>;
  finishPartial(error: unknown): Promise<void>;
}

export async function startScrapeRun(input: ScrapeRunInput): Promise<ScrapeRunHandle> {
  const res = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.source_site, input.scraper_name, input.saison],
  );
  const id = res.rows[0]!.id;

  return {
    id,
    async setTotal(n: number) {
      await query(`UPDATE raw.scrape_runs SET pages_total = $1 WHERE id = $2`, [n, id]);
    },
    async incrementPages(n = 1) {
      await query(
        `UPDATE raw.scrape_runs SET pages_scraped = pages_scraped + $1 WHERE id = $2`,
        [n, id],
      );
    },
    async finishSuccess() {
      await query(
        `UPDATE raw.scrape_runs SET finished_at = now(), status = 'success' WHERE id = $1`,
        [id],
      );
    },
    async finishFailure(error) {
      await query(
        `UPDATE raw.scrape_runs
         SET finished_at = now(), status = 'failed', error_message = $1
         WHERE id = $2`,
        [String(error instanceof Error ? error.message : error), id],
      );
    },
    async finishPartial(error) {
      await query(
        `UPDATE raw.scrape_runs
         SET finished_at = now(), status = 'partial', error_message = $1
         WHERE id = $2`,
        [String(error instanceof Error ? error.message : error), id],
      );
    },
  };
}
