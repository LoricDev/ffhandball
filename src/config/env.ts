import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  SCRAPE_USER_AGENT: z.string().min(10),
  SCRAPE_RATE_LIMIT_MS: z.coerce.number().int().min(0).default(1500),
  SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  SCRAPE_RETRY_MAX: z.coerce.number().int().min(0).default(3),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
