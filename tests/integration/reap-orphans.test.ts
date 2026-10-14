import { describe, it, expect, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { reapOrphanRuns } from "@/db/reap-orphans.js";

const SCRAPER = "test-reap-orphans";

afterAll(async () => {
  await query(`DELETE FROM raw.scrape_runs WHERE scraper_name = $1`, [SCRAPER]);
  await closePool();
});

describe("reapOrphanRuns", () => {
  it("clôture un scrape sans heartbeat récent, épargne un scrape actif", async () => {
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name = $1`, [SCRAPER]);
    const stale = await query<{ id: string }>(
      `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, last_activity_at, started_at)
       VALUES ('t', $1, '2099-2100', now() - interval '10 hours', now() - interval '12 hours') RETURNING id`,
      [SCRAPER],
    );
    const fresh = await query<{ id: string }>(
      `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, last_activity_at)
       VALUES ('t', $1, '2099-2100', now()) RETURNING id`,
      [SCRAPER],
    );

    const dry = await reapOrphanRuns({ scrapeIdleHours: 3, etlMaxHours: 6, dryRun: true });
    expect(dry.scrapes).toBeGreaterThanOrEqual(1);
    const still = await query(`SELECT status FROM raw.scrape_runs WHERE id = $1`, [stale.rows[0]!.id]);
    expect(still.rows[0]!.status).toBe("running"); // dry-run ne modifie rien

    await reapOrphanRuns({ scrapeIdleHours: 3, etlMaxHours: 6 });
    const a = await query(`SELECT status, finished_at FROM raw.scrape_runs WHERE id = $1`, [stale.rows[0]!.id]);
    const b = await query(`SELECT status FROM raw.scrape_runs WHERE id = $1`, [fresh.rows[0]!.id]);
    expect(a.rows[0]!.status).toBe("failed");
    expect(a.rows[0]!.finished_at).not.toBeNull();
    expect(b.rows[0]!.status).toBe("running");
  });
});
