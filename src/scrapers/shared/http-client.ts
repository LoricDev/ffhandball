import pRetry from "p-retry";
import { env } from "@/config/env.js";
import { HttpError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";

type Domain = string;

// Prochain instant de départ autorisé par domaine. `SCRAPE_RATE_LIMIT_MS` reste un PLANCHER
// GLOBAL : au plus une requête démarrée par intervalle et par domaine, même sous concurrence
// (politesse vis-à-vis de la source). La concurrence (pool, ailleurs) ne sert qu'à masquer la
// latence de traitement pour atteindre réellement ce plancher — pas à le dépasser.
const nextStartAt = new Map<Domain, number>();

// Réserve un créneau de façon ATOMIQUE : toutes les lectures/écritures de la Map se font
// de façon synchrone (avant tout await), donc deux appels concurrents obtiennent des
// créneaux distincts et croissants — contrairement à l'ancienne version qui lisait `last`
// puis l'écrivait après l'attente (course → rate-limit contourné).
function reserveSlot(domain: Domain): number {
  const now = Date.now();
  const start = Math.max(now, nextStartAt.get(domain) ?? 0);
  nextStartAt.set(domain, start + env.SCRAPE_RATE_LIMIT_MS);
  return start;
}

async function respectRateLimit(domain: Domain): Promise<void> {
  const wait = reserveSlot(domain) - Date.now();
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
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

export interface BinaryResponse {
  body: Buffer;
  status: number;
  url: string;
  contentType: string;
}

export async function fetchBinary(url: string): Promise<BinaryResponse> {
  const domain = new URL(url).hostname;
  return pRetry(
    async () => {
      await respectRateLimit(domain);
      logger.debug({ url }, "fetching binary");
      const res = await fetch(url, {
        headers: {
          "User-Agent": env.SCRAPE_USER_AGENT,
          Accept: "application/pdf,application/octet-stream,*/*",
        },
      });
      // HTTP 4xx/5xx are returned as data — caller decides how to handle (e.g. skip on 404).
      // Only network-level exceptions trigger retry.
      const contentType = res.headers.get("content-type") ?? "";
      const body = Buffer.from(await res.arrayBuffer());
      return { url, status: res.status, body, contentType };
    },
    {
      retries: env.SCRAPE_RETRY_MAX,
      onFailedAttempt: (err) => {
        logger.warn(
          { url, attempt: err.attemptNumber, message: err.message },
          "binary fetch failed, retrying",
        );
      },
    },
  );
}
