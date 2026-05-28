// src/api/middleware/error-handler.ts
import type { MiddlewareHandler } from "hono";
import { logger } from "@/lib/logger.js";

export function errorHandlerMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      logger.error(
        { err: String(err), url: c.req.url, method: c.req.method },
        "API unhandled error",
      );
      return c.json(
        {
          error: {
            code: "INTERNAL_ERROR" as const,
            message: err instanceof Error ? err.message : "Unknown error",
          },
        },
        500,
      );
    }
  };
}
