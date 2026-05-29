-- db/migrations/0018_api_keys.sql
-- Clés API pour l'accès payant à l'API HTTP. Token stocké hashé (sha256).
-- valid_until : date de fin d'abonnement (avancée par le système de paiement externe).
-- NULL = pas d'expiration (clé admin/gratuite).
CREATE TABLE IF NOT EXISTS core.api_keys (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_hash           text NOT NULL UNIQUE,
  key_prefix         text NOT NULL UNIQUE,
  label              text,
  active             boolean NOT NULL DEFAULT true,
  valid_until        timestamptz,
  rate_limit_per_min integer NOT NULL DEFAULT 120,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz
);
