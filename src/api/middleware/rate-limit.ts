// src/api/middleware/rate-limit.ts
import type { MiddlewareHandler } from "hono";
import { env } from "@/config/env.js";

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

export function rateLimitMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
            ?? c.req.header("x-real-ip")
            ?? "unknown";
    const now = Date.now();
    const limit = env.API_RATE_LIMIT_PER_MIN;
    const windowMs = 60 * 1000;

    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
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
