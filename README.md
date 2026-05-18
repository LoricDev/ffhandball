# ffhandball

Pipeline de scraping et de structuration des données du handball français
(ffhandball.fr et monclub.ffhandball.fr) vers PostgreSQL, en vue d'une API.

## Stack

- TypeScript 5.7 / Node 20+
- PostgreSQL 16 (Docker)
- Cheerio (HTML), Zod (validation), pg (DB), pino (logs), Vitest (tests)

## Démarrage rapide

```bash
# Pré-requis : Node 20+, Docker (psql fourni par le conteneur)

cp .env.example .env
npm install
npm run db:up           # démarre Postgres + Adminer
npm run db:migrate      # applique toutes les migrations
npm run db:seed         # charge saisons / ligues / départements
npm test                # exécute la suite de tests

# Lancer un scrape (pilote : clubs)
npm run scrape -- --entity=clubs --saison=2025-2026 \
    --url=https://www.ffhandball.fr/clubs

# Lancer l'ETL
npm run etl -- --entity=clubs --saison=2025-2026
```

## Architecture

Deux schémas Postgres : `raw` (append-only JSONB) et `core` (relationnel
normalisé). Voir [docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md](docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md).

## Structure

- `db/migrations/` — DDL SQL
- `src/scrapers/` — un scraper par entité par source
- `src/etl/` — transformations `raw → core`
- `src/cli/` — entrypoints `scrape` et `etl`
- `tests/` — unitaires + fixtures + intégration

## Adminer (UI DB)

http://localhost:8081 — système : PostgreSQL, serveur : `postgres`,
user : `ffhandball`, password : `ffhandball`, database : `ffhandball`.
