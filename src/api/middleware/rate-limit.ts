// src/api/middleware/rate-limit.ts
import type { MiddlewareHandler } from "hono";
import { env } from "@/config/env.js";

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

export function rateLimitMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const now = Date.now();
    const windowMs = 60 * 1000;

    // Requête authentifiée par clé → limite par clé ; sinon par IP (comportement historique).
    const apiKey = c.get("apiKey") as { id: string; rate_limit_per_min: number } | undefined;
    let bucketKey: string;
    let limit: number;
    if (apiKey) {
      bucketKey = `key:${apiKey.id}`;
      limit = apiKey.rate_limit_per_min;
    } else {
      const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
              ?? c.req.header("x-real-ip")
              ?? "unknown";
      bucketKey = `ip:${ip}`;
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
export function _resetBuckets(): void { buckets.clear(); }
