// src/api/lib/repositories/api-keys.repo.ts
import { randomBytes, createHash } from "node:crypto";
import { query } from "@/db/client.js";
import { env } from "@/config/env.js";

export interface ApiKeyRow {
  id: string;
  key_prefix: string;
  label: string | null;
  active: boolean;
  valid_until: string | Date | null;
  rate_limit_per_min: number;
  created_at: string | Date;
  last_used_at: string | Date | null;
}

/** Clé authentifiée minimale attachée au contexte de requête. */
export interface AuthedKey {
  id: string;
  key_prefix: string;
  rate_limit_per_min: number;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Génère un token `ffhb_<40 hex>` + son hash + son préfixe public (`ffhb_<8 hex>`). */
export function generateToken(): { token: string; key_hash: string; key_prefix: string } {
  const rand = randomBytes(20).toString("hex"); // 40 hex chars
  const token = `ffhb_${rand}`;
  return { token, key_hash: hashToken(token), key_prefix: `ffhb_${rand.slice(0, 8)}` };
}

export interface CreateApiKeyInput {
  label?: string;
  months?: number; // durée de validité ; <=0 ou undefined avec noExpiry => null
  rate_limit_per_min?: number;
  noExpiry?: boolean;
}

export interface CreatedApiKey {
  token: string;
  key_prefix: string;
  label: string | null;
  valid_until: string | Date | null;
  rate_limit_per_min: number;
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const rate = input.rate_limit_per_min ?? env.API_KEY_DEFAULT_RATE_LIMIT_PER_MIN;
  const months = input.noExpiry ? null : (input.months ?? 1);

  // Boucle de retry minimale en cas de collision (astronomiquement rare).
  for (let attempt = 0; attempt < 3; attempt++) {
    const { token, key_hash, key_prefix } = generateToken();
    try {
      const r = await query<{ valid_until: string | Date | null }>(
        `INSERT INTO core.api_keys (key_hash, key_prefix, label, rate_limit_per_min, valid_until)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5 || ' months')::interval END)
         RETURNING valid_until`,
        [key_hash, key_prefix, input.label ?? null, rate, months],
      );
      return {
        token,
        key_prefix,
        label: input.label ?? null,
        valid_until: r.rows[0]!.valid_until,
        rate_limit_per_min: rate,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("duplicate key")) throw err;
      // collision improbable → on régénère
    }
  }
  throw new Error("Impossible de générer une clé API unique après 3 tentatives");
}

/** Recherche une clé active et non expirée par token, et touche last_used_at (best-effort). */
export async function findActiveKeyByToken(token: string): Promise<AuthedKey | null> {
  const r = await query<AuthedKey>(
    `UPDATE core.api_keys
        SET last_used_at = now()
      WHERE key_hash = $1
        AND active = true
        AND (valid_until IS NULL OR valid_until >= now())
      RETURNING id, key_prefix, rate_limit_per_min`,
    [hashToken(token)],
  );
  return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
}

export async function renewApiKey(keyPrefix: string, months: number): Promise<{ valid_until: string | Date | null } | null> {
  const r = await query<{ valid_until: string | Date | null }>(
    `UPDATE core.api_keys
        SET valid_until = greatest(coalesce(valid_until, now()), now()) + ($2 || ' months')::interval
      WHERE key_prefix = $1
      RETURNING valid_until`,
    [keyPrefix, months],
  );
  return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
}

export async function revokeApiKey(keyPrefix: string): Promise<boolean> {
  const r = await query(
    `UPDATE core.api_keys SET active = false WHERE key_prefix = $1`,
    [keyPrefix],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const r = await query<ApiKeyRow>(
    `SELECT id, key_prefix, label, active, valid_until, rate_limit_per_min, created_at, last_used_at
       FROM core.api_keys ORDER BY created_at DESC`,
  );
  return r.rows;
}
