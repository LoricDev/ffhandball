// src/api/middleware/request-logger.ts
import type { MiddlewareHandler } from "hono";
import { logger } from "@/lib/logger.js";
import { query } from "@/db/client.js";
import { clientIp } from "@/api/lib/client-ip.js";

/** Sondes internes (healthcheck toutes les 5 min, etc.) : ni stockées ni comptées dans le trafic. */
const PROBE_PATHS = new Set(["/health", "/ready"]);

export function requestLoggerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const duration_ms = Date.now() - start;
    const status = c.res.status;
    const method = c.req.method;
    const path = c.req.path;
    const ip = clientIp(c);
    const key_prefix = (c.get("apiKey") as { key_prefix?: string } | undefined)?.key_prefix ?? null;

    const isProbe = PROBE_PATHS.has(path) && status < 400;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : isProbe ? "debug" : "info";
    logger[level]({ method, path, status, duration_ms, ip, key_prefix }, "API request");
    if (isProbe) return;

    // Persistance en base (fire & forget — ne bloque pas la réponse)
    query(
      `INSERT INTO core.api_logs (method, path, status, duration_ms, ip, key_prefix)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [method, path, status, duration_ms, ip, key_prefix],
    ).catch((err) => logger.warn({ err }, "api_logs insert failed"));
  };
}
