---
name: API HTTP publique
description: Design de la 10ème feature — API REST read-only pour exposer les 17 entités du pipeline ffhandball
type: spec
date: 2026-05-28
---

# API HTTP publique

## Contexte

Le pipeline a atteint sa couverture maximale sur les données publiques FFHandball (9 features livrées, 17 entités, 222 tests). Cette feature ouvre l'accès à ces données via une **API HTTP REST publique read-only**.

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Exposer les **entités principales** du pipeline via une API REST publique
- **Auto-documentation OpenAPI** (Swagger UI sur `/docs`)
- **Rate-limit IP** pour protéger des abus (~60 req/min)
- **Pagination** sur les listes (cursor ou offset)
- **Filtres** ciblés et pratiques (saison, dates, niveau, etc.)
- **Recherche fuzzy** cross-entités (clubs, équipes, joueurs)
- **Pas d'auth** pour la V1 (read-only public)
- **Conforme à la convention du projet** : TypeScript ESM, Zod, pg, pino, Vitest

## Non-objectifs

- Pas d'écriture (POST/PUT/DELETE) — API read-only en V1
- Pas d'auth utilisateur ni API key (V2 future si nécessaire)
- Pas de GraphQL (REST + OpenAPI suffisant)
- Pas de WebSocket / streaming temps réel
- Pas d'exposition des entités très volumineuses brutes (`match_actions` ~10M lignes en full run) — accès uniquement via détail match
- Pas de cache HTTP (CDN, Redis) en V1 — Postgres direct (à ajouter si scale problème)

## Stack & dépendances

```json
{
  "hono": "^4.6.0",                  // framework
  "@hono/node-server": "^1.13.0",    // adapter Node.js
  "@hono/zod-openapi": "^0.18.0",    // validation + OpenAPI auto
  "@hono/swagger-ui": "^0.5.0"       // Swagger UI sur /docs
}
```

Réutilise les libs existantes : `pg`, `zod`, `pino`, `pino-pretty`.

## Architecture

```
src/api/
├── server.ts                    # Bootstrap Hono + middlewares + mount routes
├── routes/
│   ├── health.ts                # GET /health, GET /ready
│   ├── clubs.ts                 # GET /clubs, GET /clubs/:id_ffhb
│   ├── matchs.ts                # GET /matchs, GET /matchs/:id_ffhb_match
│   ├── classements.ts           # GET /classements
│   ├── joueurs.ts               # GET /joueurs/:numero_licence
│   └── search.ts                # GET /search
├── middleware/
│   ├── rate-limit.ts            # IP-based rate-limit (in-memory bucket)
│   ├── error-handler.ts         # JSON error responses uniformes
│   └── request-logger.ts        # Pino HTTP logger
├── schemas/                     # Zod schemas API (request/response)
│   ├── common.ts                # ErrorResponse, Pagination, etc.
│   ├── club.api.ts
│   ├── match.api.ts
│   ├── classement.api.ts
│   ├── joueur.api.ts
│   └── search.api.ts
└── lib/
    ├── pagination.ts            # offset/limit helpers
    └── repositories/            # Couche données SQL (1 par entité)
        ├── club.repo.ts
        ├── match.repo.ts
        ├── classement.repo.ts
        ├── joueur.repo.ts
        └── search.repo.ts
```

## Endpoints V1

### Health & monitoring

- `GET /health` → `{ "status": "ok" }` (200 toujours, liveness)
- `GET /ready` → `{ "status": "ready", "db": "connected" }` (200 si DB OK, 503 sinon)

### Clubs

- `GET /clubs?q=...&departement=...&limit=20&offset=0`
  - Liste paginée avec filtres : recherche fuzzy nom (`q`), filtre département (`departement` code 2-3 chars), pagination offset/limit (max 100)
  - Réponse : `{ data: Club[], meta: { total, limit, offset } }`

- `GET /clubs/:id_ffhb`
  - Détail club + salle principale jointe + counts engagements/équipes
  - 404 si introuvable

### Matchs

- `GET /matchs?poule_id_ffhb=...&date_from=...&date_to=...&statut=...&limit=20&offset=0`
  - Filtres : `poule_id_ffhb` (UNIQUE), `date_from`/`date_to` (ISO 8601), `statut` (`joue`/`a_jouer`/`reporte`/`annule`/`forfait`), pagination
  - Réponse : liste matchs avec équipes (libellés résolus), scores, date, statut, journée, lien FdM (fdm_url) si dispo

- `GET /matchs/:id_ffhb_match`
  - Détail enrichi : compositions complètes des 2 équipes (joueurs + stats par match), actions chronologiques (déroulé), arbitres, salle
  - **Charge match_compositions + match_actions + match_officiels via JOINs**
  - Réponse complète, pas de pagination interne

### Classements

- `GET /classements?poule_id_ffhb=X`
  - Snapshot classement d'une poule (paramètre obligatoire). Trié par `position ASC`.
  - Réponse : 14 lignes typiques (1 par équipe) avec position, points, J/G/N/P, BP/BC, diff, dernières rencontres
  - 400 si `poule_id_ffhb` manquant, 404 si poule introuvable

### Joueurs

- `GET /joueurs/:numero_licence`
  - Détail joueur + stats agrégées (sum buts, 7m, tirs, arrêts cross-matchs) + historique matchs (10 derniers avec scores et stats)
  - 404 si introuvable

### Recherche

- `GET /search?q=...&type=clubs|equipes|joueurs|all&limit=10`
  - Recherche fuzzy (pg_trgm) sur clubs.nom, equipes.nom, joueurs.nom+prenom
  - Si `type=all` (défaut), top 10 résultats cross-entités
  - Réponse : `{ data: [{ type, id, nom, ... }] }`

### Documentation

- `GET /openapi.json` → spec OpenAPI 3.1 auto-générée
- `GET /docs` → Swagger UI interactif

## Format réponses

### Succès (liste)

```json
{
  "data": [...],
  "meta": {
    "total": 2326,
    "limit": 20,
    "offset": 0
  }
}
```

### Succès (détail)

```json
{
  "data": { ... }
}
```

### Erreur

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Club avec id_ffhb=XYZ introuvable"
  }
}
```

Codes erreur normalisés :
- `BAD_REQUEST` (400)
- `NOT_FOUND` (404)
- `RATE_LIMIT_EXCEEDED` (429)
- `INTERNAL_ERROR` (500)
- `SERVICE_UNAVAILABLE` (503 — DB down)

## Middleware

### Rate-limit (IP-based)

In-memory bucket (Map<IP, { count, resetAt }>) :
- **60 req/min par IP** (config via env `API_RATE_LIMIT_PER_MIN`)
- Headers retournés : `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- 429 si dépassé avec `Retry-After`
- Reset automatique chaque minute

⚠️ Limitation : in-memory = non distribué. Pour scale horizontal, switcher vers Redis (future).

### Error handler

Catch global qui transforme toute exception en JSON `{ error: {...} }`. Logs via pino avec contexte (req URL, method, IP).

### Request logger

Pino HTTP logger : 1 log structuré par requête (method, url, status, duration_ms, IP, user-agent). Niveau `info` par défaut, `warn` pour 4xx, `error` pour 5xx.

## Configuration

Nouvelles variables d'environnement (`.env`) :

```env
API_PORT=3000
API_HOST=127.0.0.1                    # 0.0.0.0 en prod
API_RATE_LIMIT_PER_MIN=60
API_PAGINATION_DEFAULT_LIMIT=20
API_PAGINATION_MAX_LIMIT=100
```

## Lancement

Nouveau script `package.json` :
```json
"api": "node --env-file=.env --import tsx src/api/server.ts",
"api:dev": "node --env-file=.env --watch --import tsx src/api/server.ts"
```

```bash
npm run api          # production
npm run api:dev      # watch mode (auto-reload)
```

URL d'accès :
- `http://localhost:3000/health`
- `http://localhost:3000/docs` (Swagger UI)
- `http://localhost:3000/clubs?q=brest`

## Tests

### Tests unitaires (par route + middleware)

- `tests/api/routes/health.test.ts` (2 tests : /health 200, /ready 200/503)
- `tests/api/routes/clubs.test.ts` (4 tests : liste paginated, filtres, détail OK, détail 404)
- `tests/api/routes/matchs.test.ts` (4 tests : liste filtrée, détail enrichi, 404)
- `tests/api/routes/classements.test.ts` (3 tests : OK, missing param 400, poule 404)
- `tests/api/routes/joueurs.test.ts` (3 tests : OK avec stats agrégées, 404, format historique)
- `tests/api/routes/search.test.ts` (4 tests : clubs match, joueurs match, multi-types, q empty)
- `tests/api/middleware/rate-limit.test.ts` (3 tests : sous limite, dépassement, reset)

Total : ~25 tests + intégration end-to-end.

### Test intégration end-to-end

`tests/integration/api-end-to-end.test.ts` :
- Setup : seed minimal (1 club, 1 match, 1 classement, 1 joueur)
- Lancer le serveur Hono via `serve()` programmatique
- Faire 5-6 requêtes fetch sur les endpoints clés
- Vérifier responses + format JSON normalisé

### Tests OpenAPI

Vérifier que `/openapi.json` est valide et liste tous les endpoints attendus.

## Pagination détaillée

### Offset/limit (V1)

```
GET /clubs?limit=20&offset=40
```

Query params :
- `limit` : 1 à 100 (défaut 20)
- `offset` : ≥ 0 (défaut 0)

Réponse meta :
```json
{ "total": 2326, "limit": 20, "offset": 40 }
```

**Pas de cursor-based V1** — offset suffisant vu les volumétries (max ~10k matchs national en mode courant). Cursor en V2 si besoin (pour `match_actions` ~10M).

## Recherche fuzzy (pg_trgm)

`pg_trgm` est déjà installé en migration 0003 et utilisé sur indexes GIN dans `core.clubs.nom`, `core.equipes.nom`, `core.arbitres.nom`. La route `/search` utilise `similarity()` :

```sql
SELECT id_ffhb, nom, ville, 'club' AS type, similarity(nom, $1) AS score
  FROM core.clubs
  WHERE nom % $1
  UNION ALL
SELECT id_ffhb, nom, NULL AS ville, 'equipe', similarity(nom, $1)
  FROM core.equipes
  WHERE nom % $1
  UNION ALL
SELECT numero_licence AS id_ffhb, nom || ' ' || prenom AS nom, NULL, 'joueur', similarity(nom || ' ' || prenom, $1)
  FROM core.joueurs
  WHERE (nom || ' ' || prenom) % $1
ORDER BY score DESC
LIMIT $2;
```

Filtre `type` ajoute un `WHERE type = $type`.

## OpenAPI auto-généré

Via `@hono/zod-openapi` : chaque route déclare son schema input/output via Zod (`createRoute`). Le spec OpenAPI complète est exposée à `/openapi.json` et rendue par Swagger UI sur `/docs`.

Exemple :
```ts
const getClubRoute = createRoute({
  method: "get",
  path: "/clubs/{id_ffhb}",
  request: { params: z.object({ id_ffhb: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: clubResponseSchema } }, description: "OK" },
    404: { content: { "application/json": { schema: errorResponseSchema } }, description: "Not found" },
  },
});
```

## Cas dégradés

| Cas | Comportement |
|---|---|
| DB déconnectée | `/ready` 503, autres routes 500 INTERNAL_ERROR |
| Paramètre invalide (Zod fail) | 400 BAD_REQUEST avec détail erreur |
| Entité introuvable | 404 NOT_FOUND |
| Rate-limit dépassé | 429 + header `Retry-After` |
| Recherche query vide ou < 2 chars | 400 BAD_REQUEST |
| Limite/offset hors bornes | Clampé silencieusement (limit→100 max, offset≥0) |
| `match_actions` charge lourde (~96 lignes/match max raisonnable) | OK direct, pas de pagination interne |
| Endpoint inexistant | 404 NOT_FOUND (gestion Hono native) |

## Volumétrie & perf attendues

- Latence cible : **< 100ms p50** sur la plupart des endpoints (Postgres + index existants)
- Endpoint le plus lourd : `GET /matchs/:id` avec compositions + actions = ~3 JOINs + ~96 actions max → ~50-150ms
- Throughput : 60 req/min/IP × N IPs simultanées → suffisant pour MVP, monitoring via logs pino
- Pas de cache → chaque requête tape Postgres direct. Si bottleneck observé, ajouter Redis ou cache HTTP en V2.

## Pipeline state après cette feature

```
✅ Pipeline scraping/ETL complet (9 features, 222 tests)
✅ API HTTP publique read-only             ← cette feature
⏭ V2 API future : agrégations cross-table, cache, GraphQL ?, WebSocket live scores ?
⏭ Frontend client (si besoin)
⏭ Mobile app via API
```

## Future features liées

- **V2 API** : POST endpoints pour rescrape on-demand (auth required), WebSocket live scores via Postgres LISTEN/NOTIFY, agrégations stats avancées
- **Frontend web** : Next.js / Astro / Vue qui consomme cette API
- **Mobile app** : React Native / Flutter
- **Cache Redis** : pour les endpoints les plus chauds (top matchs, top buteurs)
- **Auth optionnelle** : API key pour rate-limit élevé (clients commerciaux ?)
