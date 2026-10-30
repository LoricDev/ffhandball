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

API REST read-only basée sur **Hono 4** avec spec **OpenAPI 3.1** auto-générée et rate-limit IP intégré (60 req/min configurable). **Authentification par clé API optionnelle** (`API_AUTH_ENABLED`) pour un accès payant : voir [docs/runbook.md#authentification-par-clé-api-monétisation](docs/runbook.md#api-http-publique).

```bash
pnpm api        # → http://localhost:3000
pnpm api:dev    # watch mode (dev)
open http://localhost:3000/docs   # Swagger UI interactif
```

Les routes de données sont préfixées par `/v1` (`/health`, `/status`, `/docs`, `/openapi.json` et `/admin` ne le sont pas). Endpoints : `/health`, `/ready`, `/status` (fraîcheur des données, public), `/statut` (page de statut publique), `/v1/saisons`, `/v1/departements`, `/v1/ligues`, `/v1/clubs`, `/v1/clubs/:id_ffhb`, `/v1/clubs/:id_ffhb/matchs`, `/v1/clubs/:id_ffhb/equipes`, `/v1/clubs/:id_ffhb/joueurs`, `/v1/clubs/:id_ffhb/classements`, `/v1/competitions`, `/v1/competitions/:id_ffhb`, `/v1/poules/:id_ffhb`, `/v1/poules/:id_ffhb/matchs`, `/v1/equipes/:id_ffhb`, `/v1/equipes/:id_ffhb/matchs`, `/v1/equipes/:id_ffhb/joueurs`, `/v1/matchs`, `/v1/matchs/:id`, `/v1/classements`, `/v1/stats-joueurs`, `/v1/joueurs/:numero_licence`, `/v1/joueurs/:numero_licence/matchs`, `/v1/arbitres`, `/v1/arbitres/:id_ffhb`, `/v1/arbitres/:id_ffhb/matchs`, `/v1/salles/:id_ffhb`, `/v1/salles/:id_ffhb/matchs`, `/v1/search`, `/openapi.json`. Listes de matchs (`/v1/matchs`, `/v1/poules|equipes|salles/:id/matchs`) : filtres `date_from`/`date_to` (ISO 8601), `statut`, `journee`, `tri=date_asc|date_desc` ; `/v1/matchs` accepte en plus `poule_id_ffhb`, `competition_id_ffhb`, `equipe_id_ffhb`, `club_id_ffhb`, `salle_id_ffhb`. Erreurs : `{ error: { code, message } }` ; un 500 ne contient qu'un `request_id` (aussi en-tête `X-Request-Id`) à retrouver dans les logs. Les endpoints clubs acceptent `id_ffhb` (id_club monclub) **ou** le code FFHB 7 chiffres.

Conventions de réponse : `{ data }` pour un objet, `{ data, meta }` pour une liste (`meta.total`, `limit`, `offset`, et `saison` quand la liste est propre à une saison). Dates-heures en ISO 8601, jours en `YYYY-MM-DD`. Une poule existante sans classement ni stats renvoie `200` avec `data: []` (`404` seulement si la poule est inconnue). `/v1/search` : `type=club|equipe|joueur|all` (les pluriels `clubs|equipes|joueurs` sont dépréciés). `/v1/joueurs/:licence/matchs` et `/v1/arbitres/:id/matchs` acceptent aussi `tri`.

**Groupes** (équipes réelles d'un club : catégorie, sexe, rang, entente). Chez FFHB une « équipe » est une inscription à une compétition ; les groupes les regroupent en équipe réelle, avec les corrections manuelles de `core.equipe_overrides`. `/v1/clubs/:id/equipes?grouper=true` les détaille dans `meta.groupes`. Les autres endpoints club y renvoient par clé : `groupe_cle` sur chaque match (`/v1/clubs/:id/matchs`) et classement (`/v1/clubs/:id/classements`), `groupes` (liste de clés) par joueur (`/v1/clubs/:id/joueurs?saison=`, `matchs`/`buts` restant cumulés toutes saisons), `meta.groupes` pour les libellés, et filtre `?groupe=<cle>` sur matchs et classements. `/v1/equipes/:id` expose `groupe` (calculé dans le club porteur).

Détails complets (options, rate-limit, format réponse) : [docs/runbook.md#api-http-publique](docs/runbook.md#api-http-publique).

## Stack

- **Runtime** : Node.js 20+, TypeScript 5.7, tsx
- **DB** : PostgreSQL 16 (Docker)
- **Scraping** : Cheerio (HTML), p-retry (résilience)
- **Validation** : Zod
- **API** : Hono 4 + @hono/zod-openapi + @hono/swagger-ui
- **Tests** : Vitest (~500 tests), exécutés sur GitHub Actions (typecheck + migrations + tests sur Postgres)
- **Logs** : pino

## Déploiement en production

Pour déployer en prod sur un VPS frais : voir [`deploy/README.md`](deploy/README.md) — 1 commande, tout automatisé (DB, API, nginx, HTTPS, cron).

## Démarrage rapide

```bash
# Pré-requis : Node 20+, Docker

cp .env.example .env       # adapter SCRAPE_USER_AGENT avec un email de contact
pnpm install
pnpm db:up              # Postgres + Adminer
pnpm db:migrate         # 30 migrations
pnpm db:seed            # saisons + ligues + départements
pnpm test                   # ~500 tests (run en séquentiel pour éviter deadlocks)

# Smoke test : 5 compétitions nationales avec leurs équipes
pnpm scrape --entity=competitions --saison=2025-2026 --level=national --limit=5
pnpm etl --entity=competitions --saison=2025-2026
pnpm etl --entity=phases       --saison=2025-2026
pnpm etl --entity=poules       --saison=2025-2026
pnpm etl --entity=equipes      --saison=2025-2026
pnpm etl --entity=engagements  --saison=2025-2026
```

## Documentation

| Document | Pour qui |
|---|---|
| **`docs/INSTALL.md`** | Installation pas-à-pas, troubleshooting |
| **`docs/DEPLOY.md`** | Déploiement production (VPS, cron nocturne, backup, monitoring) |
| **`docs/runbook.md`** | Toutes les commandes opérationnelles par entité + API |
| **`docs/webhooks.md`** | Webhooks de résultats : abonnement, format, signature HMAC, reprises |
| **`docs/billing-integration.md`** | Intégration site de paiement ↔ clés API (Stripe → admin) |
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
pnpm scrape --entity=clubs        --saison=2025-2026 --url=https://www.ffhandball.fr/clubs
pnpm scrape --entity=club-details --saison=2025-2026
pnpm etl --entity=salles --saison=2025-2026
pnpm etl --entity=clubs  --saison=2025-2026

# Phase 2 — Compétitions / phases / poules / équipes / engagements (~1h)
pnpm scrape --entity=competitions --saison=2025-2026
pnpm etl --entity=competitions  --saison=2025-2026
pnpm etl --entity=phases        --saison=2025-2026
pnpm etl --entity=poules        --saison=2025-2026
pnpm etl --entity=equipes       --saison=2025-2026
pnpm etl --entity=engagements   --saison=2025-2026

# Phase 3 — Matchs (journée courante : ~1h ; --journees=all : 17-33h)
pnpm scrape --entity=matchs --saison=2025-2026             # courante par défaut
# OU :
pnpm scrape --entity=matchs --saison=2025-2026 --journees=all

pnpm etl --entity=matchs           --saison=2025-2026
pnpm etl --entity=arbitres         --saison=2025-2026   # depuis raw.matchs
pnpm etl --entity=match_officiels  --saison=2025-2026   # depuis raw.matchs

# Phase 4 — Stats joueurs (national + régional séniors) + classements (~30 min)
pnpm scrape --entity=classements --saison=2025-2026
pnpm etl --entity=classements --saison=2025-2026
pnpm scrape --entity=stats-joueurs --saison=2025-2026
pnpm etl --entity=stats-joueurs --saison=2025-2026

# Phase 5 — Feuilles de match PDFs (LONG : 30-100h multi-nuits selon scope)
pnpm scrape --entity=feuilles-match --saison=2025-2026
pnpm etl --entity=feuilles-match --saison=2025-2026   # cascade joueurs+compositions+actions

# Scrape ciblé sur un club (code FFHB 7 chiffres ou id_ffhb), ententes comprises.
# Les poules viennent des engagements déjà en base : clubs + matchs (ou compétitions/poules/équipes/engagements) d'abord.
# Supporté : club-details, matchs, classements, stats-joueurs, feuilles-match.
pnpm scrape --entity=matchs         --saison=2025-2026 --club=5657013 --journees=all
pnpm scrape --entity=classements    --saison=2025-2026 --club=5657013
pnpm scrape --entity=stats-joueurs  --saison=2025-2026 --club=5657013
pnpm scrape --entity=feuilles-match --saison=2025-2026 --club=5657013
pnpm etl --entity=matchs --saison=2025-2026   # puis classements, stats-joueurs, feuilles-match (acceptent aussi --club, pour ne retraiter que le club)

# Phase 6 — Démarrer l'API HTTP
pnpm api                                                  # http://localhost:3000
open http://localhost:3000/docs                              # Swagger UI
```

### Suivre l'état du pipeline

```bash
pnpm status                       # saison la plus récente (--saison optionnel)
pnpm status --saison=2025-2026    # saison explicite
pnpm status --json                # sortie JSON (monitoring / cron)
```

Affiche, pour la saison : le bilan scrape/ETL (✓ ~ ✗ … + dernier run), la dernière
exécution par entité (durée, lignes ins/upd/rej, warnings), la volumétrie `raw` et
`core`, et les incidents. Détails : [docs/runbook.md#suivre-létat-du-pipeline](docs/runbook.md).

### Mise à jour post-match (scores + feuilles de match)

ffhandball.fr **n'est pas temps réel** : le score arrive avec la feuille de match et n'est
publié par le serveur ffhandball qu'**à partir du lendemain** (FdM encore plus tard). Un **cron
quotidien** (le matin) sur les derniers jours suffit — inutile de poller souvent :

```bash
pnpm scrape --entity=matchs         --saison=2025-2026 --days=3           # scores des 3 derniers jours
pnpm etl    --entity=matchs         --saison=2025-2026 --incremental      # ETL du seul delta (~secondes)
pnpm scrape --entity=feuilles-match --saison=2025-2026 --days=10          # FdM (publiées plus tard)
pnpm etl    --entity=feuilles-match --saison=2025-2026
```

Scoping temporel `--days=N` / `--weekend` / `--from`/`--to`, ETL `--incremental`. Le scrape FdM
ne cible que les matchs joués (jusqu'à aujourd'hui). On ne peut pas savoir « ce qui a changé »
sans fetch (pas de feed/ETag côté source), mais `--days` ne re-scrape que ce qui *peut* avoir
changé, et la dédup `payload_hash` rend gratuit un re-scrape sans nouveauté.
Détails et boucle : [docs/runbook.md#mise-à-jour-post-match-scores--feuilles-de-match](docs/runbook.md).

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
│   ├── migrations/      # 30 migrations SQL séquentielles
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

**17 entités modèle • 30 migrations • 13 ETLs • 30+ endpoints API • ~500 tests**

Pipeline production-ready. Voir `docs/DEPLOY.md` pour déployer et `docs/runbook.md` pour toutes les commandes opérationnelles.
