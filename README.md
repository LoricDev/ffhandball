# ffhandball

Pipeline de scraping et de structuration des données du handball français
(`ffhandball.fr` + `monclub.ffhandball.fr`) vers PostgreSQL, en vue d'une API publique.

## État du pipeline

| Entité | Source | Volumétrie | Statut |
|---|---|---|---|
| `clubs` | ffhandball.fr + fiche monclub | ~2326 | ✅ |
| `salles` | fiche club monclub | ~1500 (3/8 clubs sans salle) | ✅ |
| `competitions` + `phases` + `poules` | ffhandball.fr (3 niveaux) | ~1990 / ~3k / ~5k | ✅ |
| `equipes` + `engagements` | calendar-button des fiches compétition | ~5-10k / ~40k | ✅ |
| `matchs` | rencontre-list par poule | ~50-200k (--journees=all) | ✅ |
| `arbitres` + `match_officiels` | dérivés de raw.matchs (sans re-scrape) | ~5-15k / ~100-400k | ✅ |
| `classements` | competitions---classements par poule | ~5k lignes/snapshot | ✅ |
| `stats_joueurs` | competitions---stats-joueurs (national + régional séniors) | ~30-100k lignes | ✅ |
| `feuilles_match` → `joueurs` + `match_compositions` + `match_actions` + `match_officiels` | media-ffhb-fdm.ffhandball.fr | ~150k FdMs / ~500k joueurs / ~10M match_actions (full run) | ✅ |
| `joueurs` (complets) + `licences` | derrière login GestHand | — | ❌ (RGPD) |

## API HTTP

API REST read-only basée sur **Hono 4** avec spec **OpenAPI 3.1** auto-générée et rate-limit IP intégré (60 req/min configurable).

```bash
npm run api        # → http://localhost:3000
npm run api:dev    # watch mode (dev)
open http://localhost:3000/docs   # Swagger UI interactif
```

Endpoints V1 : `/health`, `/ready`, `/clubs`, `/clubs/:id_ffhb`, `/clubs/:id_ffhb/matchs`, `/matchs`, `/matchs/:id`, `/classements`, `/joueurs/:numero_licence`, `/search`, `/openapi.json`.

Détails complets (options, rate-limit, format réponse) : [docs/runbook.md#api-http-publique](docs/runbook.md#api-http-publique).

## Stack

- **Runtime** : Node.js 20+, TypeScript 5.7, tsx
- **DB** : PostgreSQL 16 (Docker)
- **Scraping** : Cheerio (HTML), p-retry (résilience)
- **Validation** : Zod
- **API** : Hono 4 + @hono/zod-openapi + @hono/swagger-ui
- **Tests** : Vitest (~250 tests passants)
- **Logs** : pino

## Déploiement en production

Pour déployer en prod sur un VPS frais : voir [`deploy/README.md`](deploy/README.md) — 1 commande, tout automatisé (DB, API, nginx, HTTPS, cron).

## Démarrage rapide

```bash
# Pré-requis : Node 20+, Docker

cp .env.example .env       # adapter SCRAPE_USER_AGENT avec un email de contact
npm install
npm run db:up              # Postgres + Adminer
npm run db:migrate         # 17 migrations
npm run db:seed            # saisons + ligues + départements
npm test                   # ~250 tests (run en séquentiel pour éviter deadlocks)

# Smoke test : 5 compétitions nationales avec leurs équipes
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=5
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
npm run etl -- --entity=equipes      --saison=2025-2026
npm run etl -- --entity=engagements  --saison=2025-2026
```

## Documentation

| Document | Pour qui |
|---|---|
| **`docs/INSTALL.md`** | Installation pas-à-pas, troubleshooting |
| **`docs/DEPLOY.md`** | Déploiement production (VPS, cron nocturne, backup, monitoring) |
| **`docs/runbook.md`** | Toutes les commandes opérationnelles par entité |
| **`docs/superpowers/specs/`** | Specs design (1 par feature livrée) |
| **`docs/superpowers/plans/`** | Plans d'implémentation TDD (1 par feature) |

## Architecture

Deux schémas Postgres complémentaires :
- **`raw.*`** — append-only JSONB, source de vérité, idempotent par natural_key
- **`core.*`** — relationnel normalisé, reconstructible depuis `raw.*` via les ETLs

Cf. spec complète : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

```
ffhandball.fr / monclub.ffhandball.fr
        │ HTTP (rate-limited, UA identifiable)
        ▼
   scrapers (purs, Zod-validés)
        │
        ▼
   raw.* (JSONB append-only + scrape_runs)
        │
        ▼
   ETLs (idempotents : DISTINCT ON + UPSERT + COALESCE)
        │
        ▼
   core.* (relationnel + FKs résolus + etl_runs/warnings/rejets)
        │
        ▼
   API REST publique (Hono + OpenAPI)
```

## Pipeline opérationnel — ordre complet

```bash
# Phase 1 — Clubs & salles (~1h)
npm run scrape -- --entity=clubs        --saison=2025-2026 --url=https://www.ffhandball.fr/clubs
npm run scrape -- --entity=club-details --saison=2025-2026
npm run etl -- --entity=salles --saison=2025-2026
npm run etl -- --entity=clubs  --saison=2025-2026

# Phase 2 — Compétitions / phases / poules / équipes / engagements (~1h)
npm run scrape -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=competitions  --saison=2025-2026
npm run etl -- --entity=phases        --saison=2025-2026
npm run etl -- --entity=poules        --saison=2025-2026
npm run etl -- --entity=equipes       --saison=2025-2026
npm run etl -- --entity=engagements   --saison=2025-2026

# Phase 3 — Matchs (journée courante : ~1h ; --journees=all : 17-33h)
npm run scrape -- --entity=matchs --saison=2025-2026             # courante par défaut
# OU :
npm run scrape -- --entity=matchs --saison=2025-2026 --journees=all

npm run etl -- --entity=matchs           --saison=2025-2026
npm run etl -- --entity=arbitres         --saison=2025-2026   # depuis raw.matchs
npm run etl -- --entity=match_officiels  --saison=2025-2026   # depuis raw.matchs

# Phase 4 — Stats joueurs (national + régional séniors) + classements (~30 min)
npm run scrape -- --entity=classements --saison=2025-2026
npm run etl -- --entity=classements --saison=2025-2026
npm run scrape -- --entity=stats-joueurs --saison=2025-2026
npm run etl -- --entity=stats-joueurs --saison=2025-2026

# Phase 5 — Feuilles de match PDFs (LONG : 30-100h multi-nuits selon scope)
npm run scrape -- --entity=feuilles-match --saison=2025-2026
npm run etl -- --entity=feuilles-match --saison=2025-2026   # cascade joueurs+compositions+actions

# Phase 6 — Démarrer l'API HTTP
npm run api                                                  # http://localhost:3000
open http://localhost:3000/docs                              # Swagger UI
```

Détails complets, options, suivi de couverture SQL : voir `docs/runbook.md`.

## Politique de scraping

- **User-Agent identifiable** obligatoire (`SCRAPE_USER_AGENT` avec adresse de contact)
- **Rate-limit** ≥ 1.5 s/req (`SCRAPE_RATE_LIMIT_MS=1500`, augmenter à 2000+ en prod)
- **Scrapes complets en nocturne** pour limiter l'impact sur les serveurs FFHandball
- **Append-only en raw** + **DISTINCT ON** côté ETL → re-runs safe sans pollution

## Structure du projet

```
ffhandball/
├── db/
│   ├── migrations/      # 17 migrations SQL séquentielles
│   ├── seeds/           # saisons, ligues, départements
│   └── data/            # volume Docker (gitignored)
├── docs/
│   ├── INSTALL.md       # installation détaillée
│   ├── DEPLOY.md        # production / cron / backup
│   ├── runbook.md       # commandes par entité
│   └── superpowers/
│       ├── specs/       # 1 spec design par feature
│       └── plans/       # 1 plan TDD par feature
├── src/
│   ├── schemas/         # Zod schemas raw.* (1 par entité)
│   ├── scrapers/        # purs (HTML → payload Zod-validé)
│   ├── etl/             # 13 pipelines raw → core (idempotents)
│   ├── api/             # API REST Hono (routes/, middleware/, schemas/, lib/repositories/)
│   ├── cli/             # entrypoints scrape + etl
│   ├── db/              # client pg
│   └── lib/             # logger, pdf-parser.ts
└── tests/
    ├── fixtures/        # HTML réels capturés
    ├── schemas/         # tests Zod
    ├── scrapers/        # tests parsing
    ├── etl/             # tests ETL avec vraie DB
    └── integration/     # tests end-to-end (par feature)
```

## Adminer

Interface web pour explorer la DB : http://localhost:8081  
système : PostgreSQL · serveur : `postgres` · user : `ffhandball` · password : `ffhandball` · database : `ffhandball`

## Contribuer

Le pipeline a un pattern bien rôdé : spec → plan TDD → exécution subagent-driven (cf. `docs/superpowers/`). Chaque feature livrée suit le même modèle (5-13 tâches incrémentales, tests TDD, intégration end-to-end, runbook).

Pour ajouter une nouvelle entité :
1. Brainstorming : explorer la source, identifier la natural_key, le scope, les FKs à résoudre
2. Spec : `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`
3. Plan : `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`
4. Implémentation TDD branche par branche, merge `--no-ff` sur master
5. Mise à jour de ce README + runbook

## Statut

**17 entités modèle • 17 migrations • 10 scrapers • 13 ETLs • 9 endpoints API • ~270 tests passants**

Pipeline production-ready. Voir `docs/DEPLOY.md` pour déployer et `docs/runbook.md` pour toutes les commandes opérationnelles.
