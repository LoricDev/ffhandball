// src/api/middleware/rate-limit.ts
import type { MiddlewareHandler } from "hono";
import { env } from "@/config/env.js";
import { clientIp } from "@/api/lib/client-ip.js";

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

// Purge des fenêtres expirées : sans cela la Map grossit d'une entrée par IP/clé vue, à vie.
const PURGE_EVERY_MS = 60 * 1000;
let lastPurge = 0;
function purgeExpired(now: number): void {
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;
  for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
}

export function rateLimitMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const now = Date.now();
    purgeExpired(now);
    const windowMs = 60 * 1000;

    // Requête authentifiée par clé → limite par clé ; sinon par IP (comportement historique).
    const apiKey = c.get("apiKey") as { id: string; rate_limit_per_min: number } | undefined;
    let bucketKey: string;
    let limit: number;
    if (apiKey) {
      bucketKey = `key:${apiKey.id}`;
      limit = apiKey.rate_limit_per_min;
    } else {
      bucketKey = `ip:${clientIp(c) ?? "unknown"}`;
      limit = env.API_RATE_LIMIT_PER_MIN;
    }

    let bucket = buckets.get(bucketKey);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count++;

    const remaining = Math.max(0, limit - bucket.count);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.floor(bucket.resetAt / 1000)));

    if (bucket.count > limit) {
      c.header("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return c.json(
        { error: { code: "RATE_LIMIT_EXCEEDED" as const, message: "Too many requests" } },
        429,
      );
    }

    await next();
  };
}

// For tests
export function _resetBuckets(): void { buckets.clear(); lastPurge = 0; }
export function _bucketCount(): number { return buckets.size; }
