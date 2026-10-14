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
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, last_activity_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [input.source_site, input.scraper_name, input.saison],
  );
  const id = res.rows[0]!.id;

  // Un kill (SIGTERM/SIGINT) ne doit pas laisser le run en 'running' : on le clôt en échec.
  let closed = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (closed) return;
    closed = true;
    query(
      `UPDATE raw.scrape_runs
          SET finished_at = now(), status = 'failed', error_message = $1
        WHERE id = $2 AND status = 'running'`,
      [`interrompu (${signal})`, id],
    ).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const close = () => {
    closed = true;
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };

  return {
    id,
    async setTotal(n: number) {
      await query(
        `UPDATE raw.scrape_runs SET pages_total = $1, last_activity_at = now() WHERE id = $2`,
        [n, id],
      );
    },
    async incrementPages(n = 1) {
      await query(
        `UPDATE raw.scrape_runs SET pages_scraped = pages_scraped + $1, last_activity_at = now() WHERE id = $2`,
        [n, id],
      );
    },
    async finishSuccess() {
      close();
      await query(
        `UPDATE raw.scrape_runs SET finished_at = now(), status = 'success', last_activity_at = now() WHERE id = $1`,
        [id],
      );
    },
    async finishFailure(error) {
      close();
      await query(
        `UPDATE raw.scrape_runs
         SET finished_at = now(), status = 'failed', last_activity_at = now(), error_message = $1
         WHERE id = $2`,
        [String(error instanceof Error ? error.message : error), id],
      );
    },
    async finishPartial(error) {
      close();
      await query(
        `UPDATE raw.scrape_runs
         SET finished_at = now(), status = 'partial', last_activity_at = now(), error_message = $1
         WHERE id = $2`,
        [String(error instanceof Error ? error.message : error), id],
      );
    },
  };
}
