import pRetry from "p-retry";
import { env } from "@/config/env.js";
import { HttpError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";

type Domain = string;
const lastRequestAt = new Map<Domain, number>();

async function respectRateLimit(domain: Domain): Promise<void> {
  const last = lastRequestAt.get(domain) ?? 0;
  const elapsed = Date.now() - last;
  const wait = env.SCRAPE_RATE_LIMIT_MS - elapsed;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt.set(domain, Date.now());
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
}

export async function fetchHtml(url: string): Promise<FetchResult> {
  const domain = new URL(url).hostname;
  return pRetry(
    async () => {
      await respectRateLimit(domain);
      logger.debug({ url }, "fetching");
      const res = await fetch(url, {
        headers: {
          "User-Agent": env.SCRAPE_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
      }
      const body = await res.text();
      return { url, status: res.status, body };
    },
    {
      retries: env.SCRAPE_RETRY_MAX,
      onFailedAttempt: (err) => {
        logger.warn(
          { url, attempt: err.attemptNumber, message: err.message },
          "fetch failed, retrying",
        );
      },
    },
  );
}
