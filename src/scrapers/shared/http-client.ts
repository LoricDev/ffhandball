import pRetry from "p-retry";
import { env } from "@/config/env.js";
import { HttpError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";

type Domain = string;

// Prochain instant de départ autorisé par domaine. Le plancher de débit (cf. rateLimitFor) est
// appliqué PAR DOMAINE : au plus une requête démarrée par intervalle et par domaine, même sous
// concurrence (politesse vis-à-vis de la source). La concurrence (pool, ailleurs) ne sert qu'à
// masquer la latence de traitement pour atteindre réellement ce plancher — pas à le dépasser.
const nextStartAt = new Map<Domain, number>();
// Instant jusqu'auquel le domaine est en pause après un blocage (cooldown), et compteur de
// blocages consécutifs pour faire croître la pause. Partagés par tous les workers concurrents.
const cooldownUntil = new Map<Domain, number>();
const consecutiveBlocks = new Map<Domain, number>();

// 403/405/429 = signal de bridage côté edge/origine (CloudFront → Apache) déclenché par le
// volume de requêtes non-cachées venant d'une seule IP. Inutile de matraquer : on note le
// blocage et on met le domaine en pause.
const BLOCK_STATUSES = new Set([403, 405, 429]);

// Domaine média des feuilles de match : CloudFront → origine, cache-miss systématique (chaque
// PDF tiré une seule fois). Il bride l'IP au 405 bien plus tôt que le HTML → plancher dédié.
const FDM_MEDIA_DOMAIN = "media-ffhb-fdm.ffhandball.fr";

// Headers de diagnostic CloudFront/origine, journalisés à chaque blocage. Ils tranchent QUI
// bride, ce qui décide si répartir sur plusieurs IP servirait à quelque chose :
//   - `server: CloudFront` (+ `x-cache: Error from cloudfront`) → rejet AU bord (WAF par IP
//     source) → distribuer sur plusieurs IP AIDERAIT.
//   - `server: Apache`/origine (+ `x-cache: Miss/Error from cloudfront`) → 405 généré par
//     l'ORIGINE sur cache-miss → l'origine ne voit que les IP de CloudFront, pas la tienne :
//     multiplier les IP n'y changerait RIEN (et augmenterait la charge → plus de 405).
// `retry-after` (429) et `x-amz-cf-pop`/`x-amz-cf-id` complètent le tableau (PoP, trace).
const CDN_DIAG_HEADERS = [
  "server", "via", "x-cache", "age", "retry-after", "x-amz-cf-pop", "x-amz-cf-id",
] as const;

function cdnDiagnostics(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of CDN_DIAG_HEADERS) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

// Plancher de débit applicable à un domaine. Global par défaut, mais le domaine média FdM a le
// sien (cf. SCRAPE_FDM_RATE_LIMIT_MS) pour ne pas déclencher le bridage CloudFront sur cache-miss.
function rateLimitFor(domain: Domain): number {
  return domain === FDM_MEDIA_DOMAIN ? env.SCRAPE_FDM_RATE_LIMIT_MS : env.SCRAPE_RATE_LIMIT_MS;
}

// Seuls les statuts transitoires sont retryés. Les 4xx déterministes (404, 410, et 403/405 qui
// sont ici un bridage instantané) ne le sont PAS : réessayer ne change rien sur le coup et
// multiplie la charge + le bruit de logs. Le 429 fait exception (retry, mais via le cooldown).
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(err: unknown): boolean {
  // HttpError → décision par statut ; sinon (erreur réseau/timeout undici) → transitoire, retry.
  return err instanceof HttpError ? isRetryableStatus(err.status) : true;
}

// Met le domaine en pause : cooldown croissant (× nb de blocages consécutifs), plafonné.
// `status` + `cdn` (headers CloudFront/origine) sont journalisés pour diagnostiquer edge vs
// origine (cf. CDN_DIAG_HEADERS) : c'est ce qui dit si répartir sur plusieurs IP servirait.
function markBlocked(domain: Domain, status: number, cdn: Record<string, string>): void {
  const n = (consecutiveBlocks.get(domain) ?? 0) + 1;
  consecutiveBlocks.set(domain, n);
  const ms = Math.min(env.SCRAPE_COOLDOWN_MS * n, env.SCRAPE_COOLDOWN_MAX_MS);
  const until = Date.now() + ms;
  if (until > (cooldownUntil.get(domain) ?? 0)) cooldownUntil.set(domain, until);
  logger.warn(
    { domain, status, consecutiveBlocks: n, cooldownMs: ms, cdn },
    "domaine bridé (HTTP 403/405/429) — mise en pause",
  );
}

function clearBlocked(domain: Domain): void {
  if (consecutiveBlocks.get(domain)) consecutiveBlocks.set(domain, 0);
}

// Réserve un créneau de façon ATOMIQUE : toutes les lectures/écritures des Maps se font
// de façon synchrone (avant tout await), donc deux appels concurrents obtiennent des
// créneaux distincts et croissants — contrairement à l'ancienne version qui lisait `last`
// puis l'écrivait après l'attente (course → rate-limit contourné). Le créneau respecte à la
// fois le plancher de débit ET un éventuel cooldown actif (reprise douce, espacée).
function reserveSlot(domain: Domain): number {
  const now = Date.now();
  const start = Math.max(now, nextStartAt.get(domain) ?? 0, cooldownUntil.get(domain) ?? 0);
  nextStartAt.set(domain, start + rateLimitFor(domain));
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
        if (BLOCK_STATUSES.has(res.status)) markBlocked(domain, res.status, cdnDiagnostics(res));
        throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
      }
      clearBlocked(domain);
      const body = await res.text();
      return { url, status: res.status, body };
    },
    {
      retries: env.SCRAPE_RETRY_MAX,
      // N'autorise le retry que sur les statuts transitoires (cf. isRetryableStatus). Un 404/405
      // est abandonné immédiatement → la page fautive est sautée sans 4 tentatives inutiles.
      shouldRetry: (err) => isRetryableError(err),
      onFailedAttempt: (err) => {
        if (isRetryableError(err) && err.retriesLeft > 0) {
          logger.warn({ url, attempt: err.attemptNumber, message: err.message }, "fetch failed, retrying");
        } else {
          logger.warn({ url, attempt: err.attemptNumber, message: err.message }, "fetch failed (non-retryable), skipping");
        }
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
      // Only network-level exceptions trigger retry. On alimente quand même le cooldown : un
      // 403/405/429 ici (PDF FdM) signale le même bridage IP que pour le HTML.
      if (BLOCK_STATUSES.has(res.status)) markBlocked(domain, res.status, cdnDiagnostics(res));
      else if (res.ok) clearBlocked(domain);
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
