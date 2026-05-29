# Authentification API par clé (monétisation abonnement) — Design

**Date :** 2026-05-29
**Périmètre :** ajouter une couche d'auth par **clé API** sur l'API REST, pour gating payant
(€1/mois géré par un site externe). **Hors périmètre : paiement** (Stripe/CB) — géré par le site ;
l'API ne fait que valider des clés dont la validité (`valid_until`) est avancée par le site à chaque
paiement.

## Principes

- **Clés opaques révocables** : token `ffhb_<40 hex>`, stocké **hashé** (sha256) en base. Le token
  en clair n'est montré qu'une fois (à la création).
- **Abonnement = `valid_until`** : l'API refuse (401) si `valid_until < now()`. Le site avance la
  date à chaque paiement. `valid_until = NULL` ⇒ clé sans expiration (admin/gratuit).
- **Toggle `API_AUTH_ENABLED`** (défaut `false`) : auth désactivée par défaut → comportement actuel
  (mode libre) inchangé, tests existants non impactés. Activée en prod via `.env`.
  `buildApp({ authEnabled })` permet de tester les deux modes sans état global.
- **Public (sans clé)** : `/health`, `/ready`, `/openapi.json`, `/docs`, `/admin/*` (l'admin a son
  propre garde). **Protégé** : tous les endpoints data.
- **Rate-limit par clé** quand authentifié (sinon par IP, comportement actuel).

## Migration 0018 — `core.api_keys`

```sql
CREATE TABLE IF NOT EXISTS core.api_keys (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_hash           text NOT NULL UNIQUE,          -- sha256(token) hex
  key_prefix         text NOT NULL UNIQUE,          -- ex. "ffhb_1a2b3c4d" (identifiant public)
  label              text,                           -- email / nom de l'abonné
  active             boolean NOT NULL DEFAULT true,
  valid_until        timestamptz,                    -- NULL = pas d'expiration
  rate_limit_per_min integer NOT NULL DEFAULT 120,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz
);
```

## env (nouveaux)

- `API_AUTH_ENABLED` (bool, défaut `false`)
- `ADMIN_SECRET` (string optionnel) — protège `/admin/*`. Si absent ⇒ admin renvoie 503.
- `API_KEY_DEFAULT_RATE_LIMIT_PER_MIN` (int, défaut `120`)

## Auth middleware (`src/api/middleware/auth.ts`)

- Monté seulement si `authEnabled`. Skip les chemins publics + `/admin`.
- Lit le token : `Authorization: Bearer <token>` (ou `X-API-Key: <token>`).
- `findActiveKeyByToken` : `WHERE key_hash = sha256(token) AND active AND (valid_until IS NULL OR valid_until >= now())`.
- Absent/invalide/expiré ⇒ `401 { error: { code: "UNAUTHORIZED", message } }` + header `WWW-Authenticate: Bearer`.
- OK ⇒ `c.set("apiKey", { id, key_prefix, rate_limit_per_min })`, `last_used_at = now()` (best-effort).
- Nouveau code d'erreur `UNAUTHORIZED` dans `errorResponseSchema`.

## Rate-limit (`rate-limit.ts` modifié)

- Si `c.get("apiKey")` présent ⇒ bucket `key:<id>`, limite = `rate_limit_per_min` de la clé.
- Sinon ⇒ bucket `ip:<ip>`, limite = `API_RATE_LIMIT_PER_MIN` (inchangé).

## Endpoints admin (`src/api/routes/admin.ts`) — garde `X-Admin-Secret`

Tous : 503 si `ADMIN_SECRET` non configuré ; 401 si header `X-Admin-Secret` ≠ `ADMIN_SECRET`.
- `POST /admin/api-keys` — body `{ label?, months?=1, rate_limit_per_min? }` ⇒ crée, renvoie
  `{ token (une fois), key_prefix, label, valid_until }`.
- `POST /admin/api-keys/:key_prefix/renew` — body `{ months?=1 }` ⇒
  `valid_until = greatest(coalesce(valid_until, now()), now()) + months mois`. 404 si inconnue.
- `POST /admin/api-keys/:key_prefix/revoke` ⇒ `active = false`. 404 si inconnue.

## CLI (`src/cli/apikey.ts`, `npm run apikey -- <cmd>`)

- `create --label=... [--months=1] [--rate=120]` ⇒ imprime le token une fois.
- `list` ⇒ key_prefix, label, active, valid_until, last_used_at.
- `renew --prefix=... [--months=1]`
- `revoke --prefix=...`

CLI et admin partagent `src/api/lib/repositories/api-keys.repo.ts` (génération token, hash, CRUD).

## OpenAPI

Enregistrer un security scheme `bearerAuth` (http/bearer) ⇒ bouton **Authorize** dans Swagger.

## Tests

- `tests/api/lib/api-keys.repo.test.ts` : génération token (préfixe, hash), create/find/renew/revoke,
  rejet expiré/inactif.
- `tests/api/middleware/auth.test.ts` (via `buildApp({ authEnabled: true })`) : 401 sans token,
  401 token invalide, 401 expiré, 200 token valide ; chemins publics accessibles sans clé.
- `tests/api/routes/admin.test.ts` : 503 sans ADMIN_SECRET, 401 mauvais secret, create→renew→revoke.
- Non-régression : `buildApp()` défaut (auth off) ⇒ les ~300 tests existants inchangés.

## Docs

runbook (section Authentification), README (mention auth + token), `.env.example`
(`API_AUTH_ENABLED`, `ADMIN_SECRET`), DEPLOY (activer l'auth en prod).
