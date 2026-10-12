# Structure du projet ffhandball

Documentation de l'arborescence : rôle de chaque dossier et de chaque fichier.

## Vue d'ensemble

Le projet est un **pipeline de données handball** en 3 temps, plus une API de diffusion :

```
SCRAPE (HTTP → JSON brut)  →  raw.*  →  ETL (validation + structuration)  →  core.*  →  API HTTP
```

- **TypeScript** (ESM, `tsx` pour l'exécution sans build)
- **PostgreSQL** (schémas `raw` et `core`)
- **Hono** pour l'API HTTP
- **Zod** pour la validation
- **Vitest** pour les tests

---

## Racine du projet

| Fichier | Rôle |
|---|---|
| `package.json` | Dépendances + **scripts npm** (`scrape`, `etl`, `pipeline`, `status`, `api`, `db:*`, `mail:test`, `apikey`, `test`, `typecheck`) |
| `tsconfig.json` | Config TypeScript. Compile `src/**` et `tests/**`. Alias `@/*` → `src/*` |
| `vitest.config.ts` | Config des tests |
| `docker-compose.yml` | Services locaux : PostgreSQL 16 + Adminer (UI web sur `:8081`) |
| `.env.example` | Modèle des variables d'environnement à copier en `.env` |
| `.gitignore` | Fichiers exclus du versioning |
| `README.md` | Présentation générale du projet |

---

## `src/` — code source

### `src/config/`
| Fichier | Rôle |
|---|---|
| `env.ts` | **Source de vérité des variables d'env.** Schéma Zod qui valide `process.env` au démarrage (DATABASE_URL, SCRAPE_*, API_*, MAIL_*, ADMIN_SECRET). Crash si une variable requise manque. |

### `src/db/`
| Fichier | Rôle |
|---|---|
| `client.ts` | Pool de connexions PostgreSQL (`pg`). Expose `query()`, `withTransaction()`, `closePool()`. **Tout accès SQL passe par ici.** |

### `src/lib/` — utilitaires transverses
| Fichier | Rôle |
|---|---|
| `logger.ts` | Logger structuré (pino). Utilisé partout pour les logs JSON. |
| `errors.ts` | Classes d'erreur typées (`HttpError` avec status + url, etc.). |
| `pdf-parser.ts` | Extraction de texte brut depuis un PDF (utilisé par le parser de feuilles de match). |
| `mailer.ts` | Envoi de mails SMTP (nodemailer). `sendMail`, `sendPipelineSuccess`, `sendPipelineFailure`. Silencieux si `MAIL_*` non configuré. |

### `src/cli/` — points d'entrée en ligne de commande
| Fichier | Commande | Rôle |
|---|---|---|
| `scrape.ts` | `npm run scrape` | Orchestre le scraping d'une entité (fetch → parse → insert raw). Contient le helper résilient `tryFetchHtml`. |
| `etl.ts` | `npm run etl` | Lance l'ETL d'une entité (raw → core). Routeur simple vers `src/etl/*`. |
| `pipeline.ts` | `npm run pipeline` | Enchaîne **toutes** les étapes scrape+ETL dans le bon ordre. Options `--from`, `--dry-run`. Envoie un mail à la fin/en cas d'échec. |
| `status.ts` | `npm run status` | Affiche l'état des derniers runs (lit `raw.scrape_runs` + `core.etl_runs`) pour une saison. |
| `apikey.ts` | `npm run apikey` | Gestion des clés API (create/list/renew/revoke). |
| `mail-test.ts` | `npm run mail:test` | Teste la config SMTP et envoie un mail de vérification. |

### `src/scrapers/` — acquisition (HTTP → objets bruts)
> **Règle :** les `*.scraper.ts` sont des fonctions **pures** (HTML string → objets). Aucun accès réseau ni base dedans → testables facilement.

#### `src/scrapers/shared/`
| Fichier | Rôle |
|---|---|
| `http-client.ts` | `fetchHtml` / `fetchBinary` avec **rate-limiting par domaine** + **retry** (pRetry). User-Agent depuis `.env`. |
| `scrape-run.ts` | `startScrapeRun()` → crée une ligne dans `raw.scrape_runs` et renvoie un handle (`incrementPages`, `finishSuccess`, `finishFailure`, `finishPartial`). |
| `raw-insert.ts` | `insertRaw()` → insère dans `raw.*` avec **déduplication par hash SHA-256** du payload. |

#### `src/scrapers/ffhandball/` — parsers spécifiques au site
| Fichier | Rôle |
|---|---|
| `clubs.scraper.ts` | Liste des clubs |
| `club-slugs.scraper.ts` | Extraction des slugs de clubs (depuis monclub) |
| `club-details.scraper.ts` | Fiche détaillée d'un club (+ salle) |
| `competition-list.scraper.ts` | Liste des compétitions par niveau + structures |
| `competition-detail.scraper.ts` | Détail d'une compétition (phases, poules, équipes, engagements) |
| `rencontre-list.scraper.ts` | Liste des matchs d'une poule |
| `classement.scraper.ts` | Classement d'une poule |
| `stats-joueurs.scraper.ts` | Statistiques joueurs d'une poule |
| `fdm-pdf.parser.ts` | Parse le PDF d'une feuille de match (compo, buts, cartons, officiels) |

#### `src/scrapers/monclub/`
Réservé aux scrapers du sous-domaine monclub.ffhandball.fr (vide pour l'instant, `.gitkeep`).

### `src/schemas/` — schémas Zod des PAYLOADS BRUTS
> Décrivent la forme des objets produits par les scrapers et stockés en `raw.*`. Servent de **garde de validation** à l'ETL.

`classement` · `club` · `competition` · `engagement` · `equipe` · `feuille-match` · `match` · `phase` · `poule` · `salle` · `stats-joueur` (`.schema.ts`)

### `src/etl/` — transformation (raw → core)
> Chaque `*.etl.ts` lit `raw.<entity>`, valide, résout les FK, et **upsert** dans `core.<entity>`. Trace tout dans `core.etl_runs` / `etl_rejets` / `etl_warnings`.

| Fichier | Transforme |
|---|---|
| `clubs.etl.ts` | raw.clubs → core.clubs |
| `salles.etl.ts` | raw.salles → core.salles |
| `competitions.etl.ts` | raw.competitions → core.competitions |
| `phases.etl.ts` | raw.phases → core.phases |
| `poules.etl.ts` | raw.poules → core.poules |
| `equipes.etl.ts` | raw.equipes → core.equipes |
| `engagements.etl.ts` | raw.engagements → core.engagements |
| `matchs.etl.ts` | raw.matchs → core.matchs |
| `arbitres.etl.ts` | raw.matchs → core.arbitres (extraction) |
| `match_officiels.etl.ts` | raw.matchs → core.match_officiels |
| `classements.etl.ts` | raw.classements → core.classements |
| `stats-joueurs.etl.ts` | raw.stats_joueurs → core.stats_joueurs |
| `feuilles-match.etl.ts` | raw.feuilles_match → core.match_compositions |

#### `src/etl/shared/` — helpers de transformation
| Fichier | Rôle |
|---|---|
| `parse-saison.ts` | `canonicalizeSaison()` → normalise "2025/2026", "2025 - 2026" → `2025-2026` |
| `parse-date.ts` | Parsing/normalisation des dates ffhandball |
| `normalize-text.ts` | Normalisation de texte (accents, casse, espaces) pour le matching |
| `split-nom-complet.ts` | Sépare "NOM Prénom" en nom + prénom |
| `resolve-fk.ts` | Résolution de clés étrangères (`resolveDepartementId`, `resolveLigueIdFromDept`) |

### `src/api/` — API HTTP (Hono)
| Fichier | Rôle |
|---|---|
| `server.ts` | Construit l'app Hono, monte middlewares + routes, génère l'OpenAPI + Swagger UI (`/docs`). Point d'entrée `npm run api`. |

#### `src/api/middleware/`
| Fichier | Rôle |
|---|---|
| `request-logger.ts` | Logue chaque requête (+ persiste dans `core.api_logs`). |
| `error-handler.ts` | Capture les erreurs et renvoie un JSON d'erreur normalisé. |
| `auth.ts` | Authentification par clé API (`Authorization: Bearer`). Chemins publics exemptés. |
| `rate-limit.ts` | Limite le nombre de requêtes par minute (par clé). |

#### `src/api/routes/` — un fichier par ressource
`clubs` · `matchs` · `classements` · `joueurs` · `competitions` · `poules` · `equipes` · `stats-joueurs` · `arbitres` · `salles` · `referentiels` · `search` · `health` · `admin` (`.ts`). Chaque fichier définit les endpoints HTTP de la ressource.

#### `src/api/schemas/` — schémas Zod des RÉPONSES API
> À ne pas confondre avec `src/schemas/` (payloads bruts). Ici : forme des entrées/sorties HTTP, sert à l'OpenAPI. `common.ts` = schémas partagés (pagination, erreurs).

#### `src/api/lib/`
| Fichier | Rôle |
|---|---|
| `club-matching.ts` | Logique de rapprochement de noms de clubs |
| `repositories/*.repo.ts` | **Couche d'accès aux données** : une fonction = une requête SQL. Les routes appellent les repos, jamais le SQL directement. |

### `src/index.ts`
Point d'entrée "barrel" (actuellement vide / placeholder).

---

## `db/` — base de données

| Dossier | Rôle |
|---|---|
| `migrations/` | Scripts SQL **numérotés** (`0001`…`0019`), joués dans l'ordre par `npm run db:migrate`. Définissent les schémas `raw` et `core`. |
| `seeds/` | Données de référence initiales (`saisons`, `ligues_departements`). Jouées par `npm run db:seed`. |
| `data/` | Volume PostgreSQL local (Docker) — **non versionné**. |

> Pour comprendre le rôle de chaque table : voir la cartographie dans `docs/` ou les migrations elles-mêmes.

---

## `tests/` — tests (Vitest)

Miroir de `src/`. Trois niveaux :

| Dossier | Type de test |
|---|---|
| `tests/scrapers/` `tests/schemas/` | **Unitaires** : parsers et schémas sur des fixtures |
| `tests/etl/` `tests/api/` `tests/lib/` | Tests des ETL, de l'API et des libs |
| `tests/integration/` | **Bout-en-bout** : du scrape jusqu'à l'API |
| `tests/fixtures/` | Données figées (HTML ffhandball capturé, PDF de feuilles de match) servant d'entrées aux tests |

---

## `templates/` — modèles pour nouvelles entités

| Fichier | Rôle |
|---|---|
| `README.md` | Guide en 6 étapes pour ajouter une entité |
| `entity.schema.ts` | Modèle de schéma Zod (payload brut) |
| `entity.scraper.ts` | Modèle de parser |
| `entity.etl.ts` | Modèle d'ETL complet |

> Hors `src/` → pas compilé par `tsc`. À copier puis renommer.

---

## `deploy/` — déploiement serveur

| Élément | Rôle |
|---|---|
| `install-server.sh` | Provisionnement initial du serveur |
| `setup-app.sh` | Installation de l'application |
| `deploy-all.sh` | Déploiement complet |
| `.env.production.template` | Modèle d'env de production |
| `systemd/ffhandball-api.service.template` | Service systemd pour l'API |
| `nginx/ffhandball-api.conf.template` | Reverse-proxy nginx |
| `cron/` | Tâches planifiées : `cron-daily.sh` (scrape quotidien), `cron-weekly-fdm-recent.sh`, `cron-monthly-fdm-full.sh`, `backup-daily.sh`, `install-crontab.sh` |

---

## `docs/` — documentation

| Élément | Rôle |
|---|---|
| `STRUCTURE.md` | Ce document |
| `INSTALL.md` / `DEPLOY.md` | Installation locale / déploiement |
| `runbook.md` | Procédures d'exploitation (incidents, relances) |
| `billing-integration.md` | Intégration de la facturation (clés API) |
| `club-detail-fields.md` / `competitions-fields.md` | Référence des champs scrapés |
| `superpowers/specs/` | **Specs de conception** par fonctionnalité (le "quoi" et le "pourquoi") |
| `superpowers/plans/` | **Plans d'implémentation** par fonctionnalité (le "comment") |

---

## Flux résumé

```
                 ┌─────────────────────────────────────────────┐
                 │                  src/cli/                    │
                 │  scrape  etl  pipeline  status  api  apikey  │
                 └──────┬───────────┬──────────────────┬───────┘
                        │           │                  │
            ┌───────────▼──┐   ┌────▼─────┐      ┌──────▼──────┐
            │ src/scrapers │   │ src/etl  │      │   src/api   │
            │  (pur parse) │   │ raw→core │      │ Hono routes │
            └───────┬──────┘   └────┬─────┘      └──────┬──────┘
                    │               │                   │
   src/schemas ─────┤               ├──── src/etl/shared│  src/api/schemas
   (validation)     │               │     (helpers)     │  (I/O HTTP)
                    ▼               ▼                   ▼
              ┌─────────────────────────────────────────────┐
              │              src/db/client.ts                │
              │            (pool PostgreSQL)                 │
              └───────────────────┬─────────────────────────┘
                                  ▼
                        raw.*  ───►  core.*
```
