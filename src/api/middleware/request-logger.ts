// src/api/middleware/request-logger.ts
import type { MiddlewareHandler } from "hono";
import { logger } from "@/lib/logger.js";

export function requestLoggerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const duration_ms = Date.now() - start;
    const status = c.res.status;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    logger[level](
      {
        method: c.req.method,
        url: c.req.url,
        status,
        duration_ms,
        ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
      },
      "API request",
    );
  };
}
