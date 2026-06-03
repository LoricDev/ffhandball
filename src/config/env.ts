import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  SCRAPE_USER_AGENT: z.string().min(10),
  SCRAPE_RATE_LIMIT_MS: z.coerce.number().int().min(0).default(1500),
  SCRAPE_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  SCRAPE_RETRY_MAX: z.coerce.number().int().min(0).default(3),
  // Anti-blocage edge/origine (CloudFront → Apache) : un 403/405/429 signale que l'IP est
  // bridée par le volume. On met le domaine en pause (cooldown, croissant à chaque blocage
  // consécutif, plafonné) pour laisser la pénalité expirer au lieu de matraquer.
  SCRAPE_COOLDOWN_MS: z.coerce.number().int().min(0).default(60_000),
  SCRAPE_COOLDOWN_MAX_MS: z.coerce.number().int().min(0).default(300_000),
  // --journees=recent : fenêtre glissante (en jours) des journées récemment jouées à re-scraper
  // lors des runs réguliers (le backfill complet se fait une fois avec --journees=all).
  SCRAPE_MATCHS_RECENT_DAYS: z.coerce.number().int().positive().default(14),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().default(3000),
  API_HOST: z.string().default("127.0.0.1"),
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().default(60),
  API_PAGINATION_DEFAULT_LIMIT: z.coerce.number().int().default(20),
  API_PAGINATION_MAX_LIMIT: z.coerce.number().int().default(100),
  // Authentification par clé API (monétisation). Désactivée par défaut (mode libre).
  API_AUTH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ADMIN_SECRET: z.string().min(16).optional(),
  API_KEY_DEFAULT_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  // Notifications mail (optionnel — désactivé si absent)
  MAIL_HOST:     z.string().optional(),
  MAIL_PORT:     z.coerce.number().int().default(587),
  MAIL_USER:     z.string().optional(),
  MAIL_PASSWORD: z.string().optional(),
  MAIL_FROM:     z.string().optional(),
  MAIL_TO:       z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
