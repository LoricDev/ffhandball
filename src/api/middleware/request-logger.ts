// src/api/middleware/request-logger.ts
import type { MiddlewareHandler } from "hono";
import { logger } from "@/lib/logger.js";
import { query } from "@/db/client.js";

export function requestLoggerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const duration_ms = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;
    const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
    const key_prefix = (c.get("apiKey") as { key_prefix?: string } | undefined)?.key_prefix ?? null;

    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    logger[level]({ method, path, status, duration_ms, ip, key_prefix }, "API request");

    // Persistance en base (fire & forget — ne bloque pas la réponse)
    query(
      `INSERT INTO core.api_logs (method, path, status, duration_ms, ip, key_prefix)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [method, path, status, duration_ms, ip, key_prefix],
    ).catch((err) => logger.warn({ err }, "api_logs insert failed"));
  };
}
