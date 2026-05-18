# FFHandball Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mettre en place l'infrastructure complète (Postgres + Docker + projet TypeScript), créer **tout le schéma DB** (raw + core), et livrer **une entité pilote bout-en-bout (`clubs`)** : scraper → `raw.clubs` → ETL → `core.clubs`. Les 8 autres entités suivront via des plans dédiés ré-utilisant ce pattern.

**Architecture :** Postgres 16 avec schémas `raw` (append-only JSONB) et `core` (relationnel normalisé). Node.js / TypeScript pour scrape & ETL. Pipeline idempotent : un `scrape_run` par exécution, UPSERT par clé naturelle, validation Zod stricte côté ETL.

**Tech Stack :** TypeScript 5.7, Node 20+, Postgres 16, Docker Compose, `pg`, `zod`, `cheerio`, `date-fns`, `pino`, `p-retry`, `vitest`, `tsx`.

**Référence design :** [docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md](../specs/2026-05-18-ffhandball-data-pipeline-design.md)

---

## File Structure

```
ffhandball/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── .env.example
├── docker-compose.yml
├── README.md
│
├── db/
│   ├── migrations/
│   │   ├── 0001_create_raw_schema.sql
│   │   ├── 0002_create_core_referentiels.sql
│   │   ├── 0003_create_core_structures.sql
│   │   ├── 0004_create_core_personnes.sql
│   │   ├── 0005_create_core_activite.sql
│   │   └── 0006_create_core_etl_meta.sql
│   └── seeds/
│       ├── 01_saisons.sql
│       └── 02_ligues_departements.sql
│
├── src/
│   ├── config/
│   │   └── env.ts
│   ├── db/
│   │   └── client.ts
│   ├── lib/
│   │   ├── logger.ts
│   │   └── errors.ts
│   ├── schemas/
│   │   └── club.schema.ts
│   ├── scrapers/
│   │   ├── shared/
│   │   │   ├── http-client.ts
│   │   │   ├── scrape-run.ts
│   │   │   └── raw-insert.ts
│   │   └── ffhandball/
│   │       └── clubs.scraper.ts
│   ├── etl/
│   │   ├── shared/
│   │   │   ├── normalize-text.ts
│   │   │   ├── parse-date.ts
│   │   │   ├── parse-saison.ts
│   │   │   └── resolve-fk.ts
│   │   └── clubs.etl.ts
│   └── cli/
│       ├── scrape.ts
│       └── etl.ts
│
├── tests/
│   ├── fixtures/
│   │   └── ffhandball-clubs-listing.html
│   ├── etl/
│   │   └── shared/
│   │       ├── normalize-text.test.ts
│   │       ├── parse-date.test.ts
│   │       └── parse-saison.test.ts
│   ├── scrapers/
│   │   └── clubs.scraper.test.ts
│   └── integration/
│       └── clubs-end-to-end.test.ts
│
└── docs/
    ├── runbook.md
    └── superpowers/  (déjà existant)
```

**Responsabilités par module :**
- `db/migrations/` — DDL SQL idempotent (`IF NOT EXISTS`)
- `src/config/` — chargement et validation des variables d'environnement
- `src/db/` — connexion Postgres partagée (`pg` pool)
- `src/lib/` — logger structuré, hiérarchie d'erreurs typées
- `src/schemas/` — schémas Zod (sources de vérité des types)
- `src/scrapers/shared/` — HTTP rate-limité, lifecycle `scrape_run`, insert `raw`
- `src/scrapers/<source>/` — un fichier par entité par source, fonction pure `parseHTML(html: string): RawPayload[]`
- `src/etl/shared/` — fonctions de normalisation pures (testables sans DB)
- `src/etl/<entity>.etl.ts` — orchestration raw → core par entité
- `src/cli/` — entrypoints CLI (`tsx src/cli/scrape.ts --entity=clubs --saison=2025-2026`)

---

## Phase 1 — Project setup

### Task 1 : Initialize TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1.1 : Create `package.json`**

```json
{
  "name": "ffhandball",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "scrape": "tsx src/cli/scrape.ts",
    "etl": "tsx src/cli/etl.ts",
    "db:up": "docker compose up -d",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d",
    "db:migrate": "for f in db/migrations/*.sql; do docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < \"$f\"; done",
    "db:seed": "for f in db/seeds/*.sql; do docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < \"$f\"; done",
    "db:psql": "docker exec -it ffhandball-postgres psql -U ffhandball -d ffhandball"
  },
  "dependencies": {
    "cheerio": "^1.0.0",
    "date-fns": "^4.1.0",
    "p-retry": "^6.2.1",
    "pg": "^8.13.1",
    "pino": "^9.5.0",
    "pino-pretty": "^13.0.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 1.2 : Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 1.3 : Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
});
```

- [ ] **Step 1.4 : Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
.DS_Store
db/data/
coverage/
```

- [ ] **Step 1.5 : Create `.env.example`**

```
DATABASE_URL=postgresql://ffhandball:ffhandball@localhost:5432/ffhandball
SCRAPE_USER_AGENT=ffhandball-data-bot/0.1 (contact: TODO@example.com)
SCRAPE_RATE_LIMIT_MS=1500
SCRAPE_CONCURRENCY=2
SCRAPE_RETRY_MAX=3
LOG_LEVEL=info
NODE_ENV=development
```

- [ ] **Step 1.6 : Install dependencies and verify typecheck**

Run: `npm install && npm run typecheck`
Expected: `npm install` finishes without error, `tsc --noEmit` exits 0 (no source files yet, no errors).

- [ ] **Step 1.7 : Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example
git commit -m "chore: bootstrap typescript project"
```

---

### Task 2 : Docker Compose for local Postgres

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 2.1 : Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: ffhandball-postgres
    environment:
      POSTGRES_USER: ffhandball
      POSTGRES_PASSWORD: ffhandball
      POSTGRES_DB: ffhandball
    ports:
      - "5432:5432"
    volumes:
      - ./db/data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ffhandball -d ffhandball"]
      interval: 5s
      timeout: 5s
      retries: 10

  adminer:
    image: adminer:latest
    container_name: ffhandball-adminer
    ports:
      - "8081:8080"
    depends_on:
      postgres:
        condition: service_healthy
```

> Note : on ne monte plus `./db/migrations` dans `docker-entrypoint-initdb.d` ; on les exécute via `npm run db:migrate` après le démarrage, ce qui rend les migrations rejouables sans drop de volume.

- [ ] **Step 2.2 : Bring DB up and verify**

Run:
```bash
cp .env.example .env
docker compose up -d
docker compose ps
```

Expected: 2 services `running`, `postgres` is `(healthy)`.

Test connection:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "SELECT version();"
```
Expected: prints PostgreSQL 16.x version line.

- [ ] **Step 2.3 : Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add docker compose for postgres + adminer"
```

---

### Task 3 : Create empty project structure

**Files:**
- Create: empty directories (placeholder `.gitkeep` files)

- [ ] **Step 3.1 : Create all directories**

Run:
```bash
mkdir -p \
  db/migrations db/seeds \
  src/config src/db src/lib src/schemas \
  src/scrapers/shared src/scrapers/ffhandball src/scrapers/monclub \
  src/etl/shared \
  src/cli \
  tests/fixtures tests/etl/shared tests/scrapers tests/integration \
  docs
touch \
  db/migrations/.gitkeep db/seeds/.gitkeep \
  src/scrapers/monclub/.gitkeep
```

- [ ] **Step 3.2 : Commit**

```bash
git add db/ src/ tests/ docs/
git commit -m "chore: scaffold project directories"
```

---

## Phase 2 — Database schema

### Task 4 : Migration 0001 — `raw` schema

**Files:**
- Create: `db/migrations/0001_create_raw_schema.sql`

- [ ] **Step 4.1 : Write the migration**

```sql
-- 0001_create_raw_schema.sql
-- Schéma raw : capture brute append-only

CREATE SCHEMA IF NOT EXISTS raw;

CREATE TABLE IF NOT EXISTS raw.scrape_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  source_site     text NOT NULL,
  scraper_name    text NOT NULL,
  saison          text NOT NULL,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','success','failed','partial')),
  pages_scraped   integer NOT NULL DEFAULT 0,
  error_message   text
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_started_at
  ON raw.scrape_runs (started_at DESC);

-- Macro-générique : on définit chaque table de capture avec la même structure.
-- Voir la fonction utilitaire ci-dessous.

CREATE OR REPLACE FUNCTION raw._create_capture_table(table_name text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS raw.%I (
      id              bigserial PRIMARY KEY,
      scrape_run_id   uuid NOT NULL REFERENCES raw.scrape_runs(id),
      source_url      text NOT NULL,
      source_site     text NOT NULL,
      natural_key     text NOT NULL,
      payload         jsonb NOT NULL,
      payload_hash    text NOT NULL,
      scraped_at      timestamptz NOT NULL DEFAULT now(),
      saison          text NOT NULL,
      http_status     integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_%I_nk_saison
      ON raw.%I (natural_key, saison);
    CREATE INDEX IF NOT EXISTS idx_%I_scrape_run
      ON raw.%I (scrape_run_id);
    CREATE INDEX IF NOT EXISTS idx_%I_payload_hash
      ON raw.%I (payload_hash);
    CREATE INDEX IF NOT EXISTS idx_%I_payload_gin
      ON raw.%I USING gin (payload);
  $f$, table_name, table_name, table_name, table_name, table_name,
       table_name, table_name, table_name, table_name);
END $$;

SELECT raw._create_capture_table('clubs');
SELECT raw._create_capture_table('equipes');
SELECT raw._create_capture_table('joueurs');
SELECT raw._create_capture_table('matchs');
SELECT raw._create_capture_table('feuilles_match');
SELECT raw._create_capture_table('classements');
SELECT raw._create_capture_table('competitions');
SELECT raw._create_capture_table('arbitres');
SELECT raw._create_capture_table('salles');
```

- [ ] **Step 4.2 : Apply migration and verify**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/migrations/0001_create_raw_schema.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt raw.*"
```
Expected: lists 10 tables (`scrape_runs` + 9 capture tables).

- [ ] **Step 4.3 : Commit**

```bash
git add db/migrations/0001_create_raw_schema.sql
git commit -m "feat(db): create raw schema with 9 capture tables"
```

---

### Task 5 : Migration 0002 — `core` référentiels

**Files:**
- Create: `db/migrations/0002_create_core_referentiels.sql`

- [ ] **Step 5.1 : Write the migration**

```sql
-- 0002_create_core_referentiels.sql
-- Schéma core : référentiels (saisons, ligues, départements, salles)

CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.saisons (
  saison_code     text PRIMARY KEY,           -- '2025-2026'
  date_debut      date NOT NULL,
  date_fin        date NOT NULL,
  CHECK (saison_code ~ '^\d{4}-\d{4}$'),
  CHECK (date_fin > date_debut)
);

CREATE TABLE IF NOT EXISTS core.ligues (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL,
  nom             text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ligues_code UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS core.departements (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL,              -- '01','2A','974'
  nom             text NOT NULL,
  ligue_id        bigint REFERENCES core.ligues(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_departements_code UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS core.salles (
  id                bigserial PRIMARY KEY,
  id_ffhb           text NOT NULL,
  nom               text NOT NULL,
  adresse           text,
  code_postal       text,
  ville             text,
  departement_id    bigint REFERENCES core.departements(id),
  capacite          integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_salles_id_ffhb UNIQUE (id_ffhb)
);

CREATE INDEX IF NOT EXISTS idx_departements_ligue ON core.departements (ligue_id);
CREATE INDEX IF NOT EXISTS idx_salles_departement ON core.salles (departement_id);
```

- [ ] **Step 5.2 : Apply and verify**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/migrations/0002_create_core_referentiels.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt core.*"
```
Expected: lists `saisons`, `ligues`, `departements`, `salles`.

- [ ] **Step 5.3 : Commit**

```bash
git add db/migrations/0002_create_core_referentiels.sql
git commit -m "feat(db): create core référentiels (saisons, ligues, départements, salles)"
```

---

### Task 6 : Migration 0003 — `core` structures sportives

**Files:**
- Create: `db/migrations/0003_create_core_structures.sql`

- [ ] **Step 6.1 : Write the migration**

```sql
-- 0003_create_core_structures.sql
-- Schéma core : structures sportives

CREATE TABLE IF NOT EXISTS core.clubs (
  id                      bigserial PRIMARY KEY,
  id_ffhb                 text NOT NULL,
  nom                     text NOT NULL,
  sigle                   text,
  ville                   text,
  departement_id          bigint REFERENCES core.departements(id),
  ligue_id                bigint REFERENCES core.ligues(id),
  salle_principale_id     bigint REFERENCES core.salles(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_clubs_id_ffhb UNIQUE (id_ffhb)
);

CREATE INDEX IF NOT EXISTS idx_clubs_departement ON core.clubs (departement_id);
CREATE INDEX IF NOT EXISTS idx_clubs_ligue        ON core.clubs (ligue_id);
CREATE INDEX IF NOT EXISTS idx_clubs_nom_trgm     ON core.clubs USING gin (nom gin_trgm_ops);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS core.competitions (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  nom             text NOT NULL,
  niveau          text NOT NULL CHECK (niveau IN ('national','regional','departemental')),
  sexe            text NOT NULL CHECK (sexe IN ('M','F','mixte')),
  categorie_age   text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_competitions_id_ffhb UNIQUE (id_ffhb)
);

CREATE TABLE IF NOT EXISTS core.poules (
  id                bigserial PRIMARY KEY,
  competition_id    bigint NOT NULL REFERENCES core.competitions(id),
  code              text NOT NULL,
  nom               text NOT NULL,
  saison_code       text NOT NULL REFERENCES core.saisons(saison_code),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_poules_competition_code UNIQUE (competition_id, code)
);

CREATE TABLE IF NOT EXISTS core.equipes (
  id                bigserial PRIMARY KEY,
  club_id           bigint NOT NULL REFERENCES core.clubs(id),
  nom_equipe        text NOT NULL,
  sexe              text NOT NULL CHECK (sexe IN ('M','F','mixte')),
  categorie_age     text NOT NULL,
  saison_code       text NOT NULL REFERENCES core.saisons(saison_code),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_equipes_club_nom_saison UNIQUE (club_id, nom_equipe, saison_code)
);

CREATE TABLE IF NOT EXISTS core.engagements (
  equipe_id     bigint NOT NULL REFERENCES core.equipes(id),
  poule_id      bigint NOT NULL REFERENCES core.poules(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (equipe_id, poule_id)
);
```

- [ ] **Step 6.2 : Apply and verify**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/migrations/0003_create_core_structures.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt core.*"
```
Expected: also lists `clubs`, `competitions`, `poules`, `equipes`, `engagements`.

- [ ] **Step 6.3 : Commit**

```bash
git add db/migrations/0003_create_core_structures.sql
git commit -m "feat(db): create core structures sportives"
```

---

### Task 7 : Migration 0004 — `core` personnes

**Files:**
- Create: `db/migrations/0004_create_core_personnes.sql`

- [ ] **Step 7.1 : Write the migration**

```sql
-- 0004_create_core_personnes.sql

CREATE TABLE IF NOT EXISTS core.joueurs (
  id                bigserial PRIMARY KEY,
  numero_licence    text NOT NULL,
  nom               text NOT NULL,
  prenom            text NOT NULL,
  date_naissance    date,
  sexe              text CHECK (sexe IN ('M','F')),
  nationalite       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_joueurs_numero_licence UNIQUE (numero_licence)
);

CREATE TABLE IF NOT EXISTS core.licences (
  id                bigserial PRIMARY KEY,
  joueur_id         bigint NOT NULL REFERENCES core.joueurs(id),
  club_id           bigint NOT NULL REFERENCES core.clubs(id),
  saison_code       text   NOT NULL REFERENCES core.saisons(saison_code),
  categorie_age     text,
  type_licence      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_licences_joueur_saison UNIQUE (joueur_id, saison_code)
);

CREATE INDEX IF NOT EXISTS idx_licences_club_saison
  ON core.licences (club_id, saison_code);

CREATE TABLE IF NOT EXISTS core.arbitres (
  id                       bigserial PRIMARY KEY,
  numero_licence           text NOT NULL,
  nom                      text NOT NULL,
  prenom                   text NOT NULL,
  niveau                   text,
  club_rattachement_id     bigint REFERENCES core.clubs(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_arbitres_numero_licence UNIQUE (numero_licence)
);
```

- [ ] **Step 7.2 : Apply and verify**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/migrations/0004_create_core_personnes.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt core.*" | grep -E "joueurs|licences|arbitres"
```
Expected: 3 lines.

- [ ] **Step 7.3 : Commit**

```bash
git add db/migrations/0004_create_core_personnes.sql
git commit -m "feat(db): create core personnes (joueurs, licences, arbitres)"
```

---

### Task 8 : Migration 0005 — `core` activité de jeu

**Files:**
- Create: `db/migrations/0005_create_core_activite.sql`

- [ ] **Step 8.1 : Write the migration**

```sql
-- 0005_create_core_activite.sql

CREATE TABLE IF NOT EXISTS core.matchs (
  id                bigserial PRIMARY KEY,
  id_ffhb_match     text NOT NULL,
  poule_id          bigint NOT NULL REFERENCES core.poules(id),
  equipe_dom_id     bigint NOT NULL REFERENCES core.equipes(id),
  equipe_ext_id     bigint NOT NULL REFERENCES core.equipes(id),
  date_heure        timestamptz NOT NULL,
  heure_estimee     boolean NOT NULL DEFAULT false,
  salle_id          bigint REFERENCES core.salles(id),
  score_dom         integer,
  score_ext         integer,
  score_mt_dom      integer,
  score_mt_ext      integer,
  statut            text NOT NULL DEFAULT 'a_jouer'
                    CHECK (statut IN ('a_jouer','joue','reporte','annule','forfait')),
  journee           integer,
  feuille_validee   boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_matchs_id_ffhb UNIQUE (id_ffhb_match),
  CONSTRAINT chk_matchs_equipes_distinctes CHECK (equipe_dom_id <> equipe_ext_id)
);

CREATE INDEX IF NOT EXISTS idx_matchs_poule_date
  ON core.matchs (poule_id, date_heure);
CREATE INDEX IF NOT EXISTS idx_matchs_equipe_dom ON core.matchs (equipe_dom_id);
CREATE INDEX IF NOT EXISTS idx_matchs_equipe_ext ON core.matchs (equipe_ext_id);

CREATE TABLE IF NOT EXISTS core.match_compositions (
  id                        bigserial PRIMARY KEY,
  match_id                  bigint NOT NULL REFERENCES core.matchs(id) ON DELETE CASCADE,
  joueur_id                 bigint NOT NULL REFERENCES core.joueurs(id),
  equipe_id                 bigint NOT NULL REFERENCES core.equipes(id),
  numero_maillot            integer,
  titulaire                 boolean NOT NULL DEFAULT false,
  capitaine                 boolean NOT NULL DEFAULT false,
  gardien                   boolean NOT NULL DEFAULT false,
  but_count                 integer NOT NULL DEFAULT 0,
  exclusion_2min_count      integer NOT NULL DEFAULT 0,
  carton_jaune              boolean NOT NULL DEFAULT false,
  carton_rouge              boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_match_compositions UNIQUE (match_id, joueur_id)
);

CREATE TABLE IF NOT EXISTS core.match_officiels (
  id              bigserial PRIMARY KEY,
  match_id        bigint NOT NULL REFERENCES core.matchs(id) ON DELETE CASCADE,
  arbitre_id      bigint NOT NULL REFERENCES core.arbitres(id),
  role            text NOT NULL
                  CHECK (role IN ('arbitre_1','arbitre_2','delegue','observateur','chrono')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_match_officiels UNIQUE (match_id, arbitre_id, role)
);

CREATE TABLE IF NOT EXISTS core.classements (
  poule_id          bigint NOT NULL REFERENCES core.poules(id),
  equipe_id         bigint NOT NULL REFERENCES core.equipes(id),
  position          integer NOT NULL,
  points            integer NOT NULL DEFAULT 0,
  joues             integer NOT NULL DEFAULT 0,
  gagnes            integer NOT NULL DEFAULT 0,
  nuls              integer NOT NULL DEFAULT 0,
  perdus            integer NOT NULL DEFAULT 0,
  buts_pour         integer NOT NULL DEFAULT 0,
  buts_contre       integer NOT NULL DEFAULT 0,
  difference        integer GENERATED ALWAYS AS (buts_pour - buts_contre) STORED,
  journee_courante  integer,
  capture_date      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poule_id, equipe_id)
);
```

- [ ] **Step 8.2 : Apply and verify**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/migrations/0005_create_core_activite.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt core.*" | grep -E "matchs|compositions|officiels|classements"
```
Expected: 4 lines.

- [ ] **Step 8.3 : Commit**

```bash
git add db/migrations/0005_create_core_activite.sql
git commit -m "feat(db): create core activité (matchs, compositions, officiels, classements)"
```

---

### Task 9 : Migration 0006 — ETL metadata

**Files:**
- Create: `db/migrations/0006_create_core_etl_meta.sql`

- [ ] **Step 9.1 : Write the migration**

```sql
-- 0006_create_core_etl_meta.sql
-- Métadonnées ETL : runs, rejets, warnings, alias

CREATE TABLE IF NOT EXISTS core.etl_runs (
  id                bigserial PRIMARY KEY,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  entity            text NOT NULL,
  saison            text,
  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','success','failed','partial')),
  rows_read         integer NOT NULL DEFAULT 0,
  rows_validated    integer NOT NULL DEFAULT 0,
  rows_rejected     integer NOT NULL DEFAULT 0,
  rows_inserted     integer NOT NULL DEFAULT 0,
  rows_updated      integer NOT NULL DEFAULT 0,
  rows_noop         integer NOT NULL DEFAULT 0,
  warnings_count    integer NOT NULL DEFAULT 0,
  error_message     text
);

CREATE INDEX IF NOT EXISTS idx_etl_runs_entity_started
  ON core.etl_runs (entity, started_at DESC);

CREATE TABLE IF NOT EXISTS core.etl_rejets (
  id              bigserial PRIMARY KEY,
  etl_run_id      bigint NOT NULL REFERENCES core.etl_runs(id),
  entity          text NOT NULL,
  raw_row_id      bigint,
  natural_key     text,
  payload         jsonb NOT NULL,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_etl_rejets_run ON core.etl_rejets (etl_run_id);

CREATE TABLE IF NOT EXISTS core.etl_warnings (
  id              bigserial PRIMARY KEY,
  etl_run_id      bigint NOT NULL REFERENCES core.etl_runs(id),
  entity          text NOT NULL,
  natural_key     text,
  message         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_etl_warnings_run ON core.etl_warnings (etl_run_id);

CREATE TABLE IF NOT EXISTS core.alias_clubs (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  alias           text NOT NULL,
  CONSTRAINT uq_alias_clubs UNIQUE (alias)
);

CREATE INDEX IF NOT EXISTS idx_alias_clubs_id_ffhb ON core.alias_clubs (id_ffhb);
```

- [ ] **Step 9.2 : Apply and verify**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/migrations/0006_create_core_etl_meta.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt core.*" | grep -E "etl_|alias_"
```
Expected: 4 lines (`etl_runs`, `etl_rejets`, `etl_warnings`, `alias_clubs`).

- [ ] **Step 9.3 : Commit**

```bash
git add db/migrations/0006_create_core_etl_meta.sql
git commit -m "feat(db): create core ETL metadata tables"
```

---

### Task 10 : Seed data — saisons, ligues, départements

**Files:**
- Create: `db/seeds/01_saisons.sql`
- Create: `db/seeds/02_ligues_departements.sql`

- [ ] **Step 10.1 : Write `01_saisons.sql`**

```sql
-- 01_saisons.sql
INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES
  ('2023-2024', '2023-07-01', '2024-06-30'),
  ('2024-2025', '2024-07-01', '2025-06-30'),
  ('2025-2026', '2025-07-01', '2026-06-30')
ON CONFLICT (saison_code) DO NOTHING;
```

- [ ] **Step 10.2 : Write `02_ligues_departements.sql`**

```sql
-- 02_ligues_departements.sql
-- 13 ligues régionales FFHB (métropole + outre-mer)

INSERT INTO core.ligues (code, nom) VALUES
  ('ARA',  'Auvergne-Rhône-Alpes'),
  ('BFC',  'Bourgogne-Franche-Comté'),
  ('BRE',  'Bretagne'),
  ('CVL',  'Centre-Val de Loire'),
  ('COR',  'Corse'),
  ('GES',  'Grand-Est'),
  ('HDF',  'Hauts-de-France'),
  ('IDF',  'Île-de-France'),
  ('NOR',  'Normandie'),
  ('NAQ',  'Nouvelle-Aquitaine'),
  ('OCC',  'Occitanie'),
  ('PDL',  'Pays de la Loire'),
  ('PACA', 'Provence-Alpes-Côte d''Azur'),
  ('GUA',  'Guadeloupe'),
  ('MAR',  'Martinique'),
  ('GUY',  'Guyane'),
  ('REU',  'La Réunion'),
  ('MAY',  'Mayotte')
ON CONFLICT (code) DO NOTHING;

-- Départements métropole (96) + outre-mer (5)
INSERT INTO core.departements (code, nom, ligue_id) VALUES
  ('01', 'Ain',                          (SELECT id FROM core.ligues WHERE code='ARA')),
  ('02', 'Aisne',                        (SELECT id FROM core.ligues WHERE code='HDF')),
  ('03', 'Allier',                       (SELECT id FROM core.ligues WHERE code='ARA')),
  ('04', 'Alpes-de-Haute-Provence',      (SELECT id FROM core.ligues WHERE code='PACA')),
  ('05', 'Hautes-Alpes',                 (SELECT id FROM core.ligues WHERE code='PACA')),
  ('06', 'Alpes-Maritimes',              (SELECT id FROM core.ligues WHERE code='PACA')),
  ('07', 'Ardèche',                      (SELECT id FROM core.ligues WHERE code='ARA')),
  ('08', 'Ardennes',                     (SELECT id FROM core.ligues WHERE code='GES')),
  ('09', 'Ariège',                       (SELECT id FROM core.ligues WHERE code='OCC')),
  ('10', 'Aube',                         (SELECT id FROM core.ligues WHERE code='GES')),
  ('11', 'Aude',                         (SELECT id FROM core.ligues WHERE code='OCC')),
  ('12', 'Aveyron',                      (SELECT id FROM core.ligues WHERE code='OCC')),
  ('13', 'Bouches-du-Rhône',             (SELECT id FROM core.ligues WHERE code='PACA')),
  ('14', 'Calvados',                     (SELECT id FROM core.ligues WHERE code='NOR')),
  ('15', 'Cantal',                       (SELECT id FROM core.ligues WHERE code='ARA')),
  ('16', 'Charente',                     (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('17', 'Charente-Maritime',            (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('18', 'Cher',                         (SELECT id FROM core.ligues WHERE code='CVL')),
  ('19', 'Corrèze',                      (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('2A','Corse-du-Sud',                  (SELECT id FROM core.ligues WHERE code='COR')),
  ('2B','Haute-Corse',                   (SELECT id FROM core.ligues WHERE code='COR')),
  ('21', 'Côte-d''Or',                   (SELECT id FROM core.ligues WHERE code='BFC')),
  ('22', 'Côtes-d''Armor',               (SELECT id FROM core.ligues WHERE code='BRE')),
  ('23', 'Creuse',                       (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('24', 'Dordogne',                     (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('25', 'Doubs',                        (SELECT id FROM core.ligues WHERE code='BFC')),
  ('26', 'Drôme',                        (SELECT id FROM core.ligues WHERE code='ARA')),
  ('27', 'Eure',                         (SELECT id FROM core.ligues WHERE code='NOR')),
  ('28', 'Eure-et-Loir',                 (SELECT id FROM core.ligues WHERE code='CVL')),
  ('29', 'Finistère',                    (SELECT id FROM core.ligues WHERE code='BRE')),
  ('30', 'Gard',                         (SELECT id FROM core.ligues WHERE code='OCC')),
  ('31', 'Haute-Garonne',                (SELECT id FROM core.ligues WHERE code='OCC')),
  ('32', 'Gers',                         (SELECT id FROM core.ligues WHERE code='OCC')),
  ('33', 'Gironde',                      (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('34', 'Hérault',                      (SELECT id FROM core.ligues WHERE code='OCC')),
  ('35', 'Ille-et-Vilaine',              (SELECT id FROM core.ligues WHERE code='BRE')),
  ('36', 'Indre',                        (SELECT id FROM core.ligues WHERE code='CVL')),
  ('37', 'Indre-et-Loire',               (SELECT id FROM core.ligues WHERE code='CVL')),
  ('38', 'Isère',                        (SELECT id FROM core.ligues WHERE code='ARA')),
  ('39', 'Jura',                         (SELECT id FROM core.ligues WHERE code='BFC')),
  ('40', 'Landes',                       (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('41', 'Loir-et-Cher',                 (SELECT id FROM core.ligues WHERE code='CVL')),
  ('42', 'Loire',                        (SELECT id FROM core.ligues WHERE code='ARA')),
  ('43', 'Haute-Loire',                  (SELECT id FROM core.ligues WHERE code='ARA')),
  ('44', 'Loire-Atlantique',             (SELECT id FROM core.ligues WHERE code='PDL')),
  ('45', 'Loiret',                       (SELECT id FROM core.ligues WHERE code='CVL')),
  ('46', 'Lot',                          (SELECT id FROM core.ligues WHERE code='OCC')),
  ('47', 'Lot-et-Garonne',               (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('48', 'Lozère',                       (SELECT id FROM core.ligues WHERE code='OCC')),
  ('49', 'Maine-et-Loire',               (SELECT id FROM core.ligues WHERE code='PDL')),
  ('50', 'Manche',                       (SELECT id FROM core.ligues WHERE code='NOR')),
  ('51', 'Marne',                        (SELECT id FROM core.ligues WHERE code='GES')),
  ('52', 'Haute-Marne',                  (SELECT id FROM core.ligues WHERE code='GES')),
  ('53', 'Mayenne',                      (SELECT id FROM core.ligues WHERE code='PDL')),
  ('54', 'Meurthe-et-Moselle',           (SELECT id FROM core.ligues WHERE code='GES')),
  ('55', 'Meuse',                        (SELECT id FROM core.ligues WHERE code='GES')),
  ('56', 'Morbihan',                     (SELECT id FROM core.ligues WHERE code='BRE')),
  ('57', 'Moselle',                      (SELECT id FROM core.ligues WHERE code='GES')),
  ('58', 'Nièvre',                       (SELECT id FROM core.ligues WHERE code='BFC')),
  ('59', 'Nord',                         (SELECT id FROM core.ligues WHERE code='HDF')),
  ('60', 'Oise',                         (SELECT id FROM core.ligues WHERE code='HDF')),
  ('61', 'Orne',                         (SELECT id FROM core.ligues WHERE code='NOR')),
  ('62', 'Pas-de-Calais',                (SELECT id FROM core.ligues WHERE code='HDF')),
  ('63', 'Puy-de-Dôme',                  (SELECT id FROM core.ligues WHERE code='ARA')),
  ('64', 'Pyrénées-Atlantiques',         (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('65', 'Hautes-Pyrénées',              (SELECT id FROM core.ligues WHERE code='OCC')),
  ('66', 'Pyrénées-Orientales',          (SELECT id FROM core.ligues WHERE code='OCC')),
  ('67', 'Bas-Rhin',                     (SELECT id FROM core.ligues WHERE code='GES')),
  ('68', 'Haut-Rhin',                    (SELECT id FROM core.ligues WHERE code='GES')),
  ('69', 'Rhône',                        (SELECT id FROM core.ligues WHERE code='ARA')),
  ('70', 'Haute-Saône',                  (SELECT id FROM core.ligues WHERE code='BFC')),
  ('71', 'Saône-et-Loire',               (SELECT id FROM core.ligues WHERE code='BFC')),
  ('72', 'Sarthe',                       (SELECT id FROM core.ligues WHERE code='PDL')),
  ('73', 'Savoie',                       (SELECT id FROM core.ligues WHERE code='ARA')),
  ('74', 'Haute-Savoie',                 (SELECT id FROM core.ligues WHERE code='ARA')),
  ('75', 'Paris',                        (SELECT id FROM core.ligues WHERE code='IDF')),
  ('76', 'Seine-Maritime',               (SELECT id FROM core.ligues WHERE code='NOR')),
  ('77', 'Seine-et-Marne',               (SELECT id FROM core.ligues WHERE code='IDF')),
  ('78', 'Yvelines',                     (SELECT id FROM core.ligues WHERE code='IDF')),
  ('79', 'Deux-Sèvres',                  (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('80', 'Somme',                        (SELECT id FROM core.ligues WHERE code='HDF')),
  ('81', 'Tarn',                         (SELECT id FROM core.ligues WHERE code='OCC')),
  ('82', 'Tarn-et-Garonne',              (SELECT id FROM core.ligues WHERE code='OCC')),
  ('83', 'Var',                          (SELECT id FROM core.ligues WHERE code='PACA')),
  ('84', 'Vaucluse',                     (SELECT id FROM core.ligues WHERE code='PACA')),
  ('85', 'Vendée',                       (SELECT id FROM core.ligues WHERE code='PDL')),
  ('86', 'Vienne',                       (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('87', 'Haute-Vienne',                 (SELECT id FROM core.ligues WHERE code='NAQ')),
  ('88', 'Vosges',                       (SELECT id FROM core.ligues WHERE code='GES')),
  ('89', 'Yonne',                        (SELECT id FROM core.ligues WHERE code='BFC')),
  ('90', 'Territoire de Belfort',        (SELECT id FROM core.ligues WHERE code='BFC')),
  ('91', 'Essonne',                      (SELECT id FROM core.ligues WHERE code='IDF')),
  ('92', 'Hauts-de-Seine',               (SELECT id FROM core.ligues WHERE code='IDF')),
  ('93', 'Seine-Saint-Denis',            (SELECT id FROM core.ligues WHERE code='IDF')),
  ('94', 'Val-de-Marne',                 (SELECT id FROM core.ligues WHERE code='IDF')),
  ('95', 'Val-d''Oise',                  (SELECT id FROM core.ligues WHERE code='IDF')),
  ('971','Guadeloupe',                   (SELECT id FROM core.ligues WHERE code='GUA')),
  ('972','Martinique',                   (SELECT id FROM core.ligues WHERE code='MAR')),
  ('973','Guyane',                       (SELECT id FROM core.ligues WHERE code='GUY')),
  ('974','La Réunion',                   (SELECT id FROM core.ligues WHERE code='REU')),
  ('976','Mayotte',                      (SELECT id FROM core.ligues WHERE code='MAY'))
ON CONFLICT (code) DO NOTHING;
```

- [ ] **Step 10.3 : Apply seeds and verify**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/seeds/01_saisons.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/seeds/02_ligues_departements.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "SELECT count(*) FROM core.saisons;"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "SELECT count(*) FROM core.ligues;"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "SELECT count(*) FROM core.departements;"
```
Expected: 3 saisons, 18 ligues, 101 départements.

- [ ] **Step 10.4 : Commit**

```bash
git add db/seeds/
git commit -m "feat(db): seed saisons, ligues, départements"
```

---

## Phase 3 — Shared TypeScript infrastructure

### Task 11 : Environment config & DB client

**Files:**
- Create: `src/config/env.ts`
- Create: `src/db/client.ts`

- [ ] **Step 11.1 : Write `src/config/env.ts`**

```ts
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
```

- [ ] **Step 11.2 : Write `src/db/client.ts`**

```ts
import pg from "pg";
import { env } from "@/config/env.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
```

- [ ] **Step 11.3 : Smoke test — run a SELECT**

Run:
```bash
node --import tsx --eval "
import('./src/db/client.ts').then(async ({ query, closePool }) => {
  const r = await query('SELECT count(*)::int AS n FROM core.saisons');
  console.log('saisons count:', r.rows[0].n);
  await closePool();
});
"
```
Expected: `saisons count: 3`.

- [ ] **Step 11.4 : Commit**

```bash
git add src/config/ src/db/
git commit -m "feat: env config and Postgres pool client"
```

---

### Task 12 : Logger & typed errors

**Files:**
- Create: `src/lib/logger.ts`
- Create: `src/lib/errors.ts`

- [ ] **Step 12.1 : Write `src/lib/logger.ts`**

```ts
import pino from "pino";
import { env } from "@/config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});
```

- [ ] **Step 12.2 : Write `src/lib/errors.ts`**

```ts
export class FFHBError extends Error {
  override readonly name: string = "FFHBError";
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

export class ScrapeError extends FFHBError {
  override readonly name = "ScrapeError";
}

export class ValidationError extends FFHBError {
  override readonly name = "ValidationError";
}

export class HttpError extends ScrapeError {
  override readonly name = "HttpError";
  constructor(message: string, public readonly status: number, public readonly url: string) {
    super(message);
  }
}
```

- [ ] **Step 12.3 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 12.4 : Commit**

```bash
git add src/lib/
git commit -m "feat: logger and typed errors"
```

---

### Task 13 : HTTP client with rate-limit & retry

**Files:**
- Create: `src/scrapers/shared/http-client.ts`

- [ ] **Step 13.1 : Write `src/scrapers/shared/http-client.ts`**

```ts
import pRetry from "p-retry";
import { env } from "@/config/env.js";
import { HttpError } from "@/lib/errors.js";
import { logger } from "@/lib/logger.js";

type Domain = string;
const lastRequestAt = new Map<Domain, number>();

async function respectRateLimit(domain: Domain): Promise<void> {
  const last = lastRequestAt.get(domain) ?? 0;
  const elapsed = Date.now() - last;
  const wait = env.SCRAPE_RATE_LIMIT_MS - elapsed;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt.set(domain, Date.now());
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
}

export async function fetchHtml(url: string): Promise<FetchResult> {
  const domain = new URL(url).hostname;
  return pRetry(
    async () => {
      await respectRateLimit(domain);
      logger.debug({ url }, "fetching");
      const res = await fetch(url, {
        headers: {
          "User-Agent": env.SCRAPE_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url);
      }
      const body = await res.text();
      return { url, status: res.status, body };
    },
    {
      retries: env.SCRAPE_RETRY_MAX,
      onFailedAttempt: (err) => {
        logger.warn(
          { url, attempt: err.attemptNumber, message: err.message },
          "fetch failed, retrying",
        );
      },
    },
  );
}
```

- [ ] **Step 13.2 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 13.3 : Commit**

```bash
git add src/scrapers/shared/http-client.ts
git commit -m "feat(scrapers): http client with rate-limit and retry"
```

---

### Task 14 : `scrape_run` lifecycle & `raw` insert helper

**Files:**
- Create: `src/scrapers/shared/scrape-run.ts`
- Create: `src/scrapers/shared/raw-insert.ts`

- [ ] **Step 14.1 : Write `src/scrapers/shared/scrape-run.ts`**

```ts
import { query } from "@/db/client.js";

export interface ScrapeRunInput {
  source_site: string;
  scraper_name: string;
  saison: string;
}

export interface ScrapeRunHandle {
  id: string;
  incrementPages(n?: number): Promise<void>;
  finishSuccess(): Promise<void>;
  finishFailure(error: unknown): Promise<void>;
  finishPartial(error: unknown): Promise<void>;
}

export async function startScrapeRun(input: ScrapeRunInput): Promise<ScrapeRunHandle> {
  const res = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.source_site, input.scraper_name, input.saison],
  );
  const id = res.rows[0]!.id;

  return {
    id,
    async incrementPages(n = 1) {
      await query(
        `UPDATE raw.scrape_runs SET pages_scraped = pages_scraped + $1 WHERE id = $2`,
        [n, id],
      );
    },
    async finishSuccess() {
      await query(
        `UPDATE raw.scrape_runs SET finished_at = now(), status = 'success' WHERE id = $1`,
        [id],
      );
    },
    async finishFailure(error) {
      await query(
        `UPDATE raw.scrape_runs
         SET finished_at = now(), status = 'failed', error_message = $1
         WHERE id = $2`,
        [String(error instanceof Error ? error.message : error), id],
      );
    },
    async finishPartial(error) {
      await query(
        `UPDATE raw.scrape_runs
         SET finished_at = now(), status = 'partial', error_message = $1
         WHERE id = $2`,
        [String(error instanceof Error ? error.message : error), id],
      );
    },
  };
}
```

- [ ] **Step 14.2 : Write `src/scrapers/shared/raw-insert.ts`**

```ts
import { createHash } from "node:crypto";
import { query } from "@/db/client.js";

export interface RawRow {
  scrape_run_id: string;
  source_url: string;
  source_site: string;
  natural_key: string;
  payload: unknown;
  saison: string;
  http_status: number;
}

export function hashPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  return createHash("sha256").update(json).digest("hex");
}

export async function insertRaw(
  table: string,
  row: RawRow,
): Promise<{ id: number; inserted: boolean }> {
  const payload_hash = hashPayload(row.payload);

  // Skip insert if an identical payload already exists for (natural_key, saison)
  const dup = await query<{ id: number }>(
    `SELECT id FROM raw.${table}
     WHERE natural_key = $1 AND saison = $2 AND payload_hash = $3
     LIMIT 1`,
    [row.natural_key, row.saison, payload_hash],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    return { id: dup.rows[0]!.id, inserted: false };
  }

  const res = await query<{ id: number }>(
    `INSERT INTO raw.${table}
       (scrape_run_id, source_url, source_site, natural_key,
        payload, payload_hash, saison, http_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      row.scrape_run_id,
      row.source_url,
      row.source_site,
      row.natural_key,
      row.payload,
      payload_hash,
      row.saison,
      row.http_status,
    ],
  );
  return { id: res.rows[0]!.id, inserted: true };
}
```

> Note : `table` est interpolé directement dans la chaîne SQL — c'est volontaire et **sûr** car la valeur ne vient jamais d'une entrée utilisateur, uniquement de constantes côté code.

- [ ] **Step 14.3 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 14.4 : Commit**

```bash
git add src/scrapers/shared/
git commit -m "feat(scrapers): scrape_run lifecycle and raw insert helper"
```

---

## Phase 4 — Pure normalization functions (TDD)

### Task 15 : `normalize-text` (TDD)

**Files:**
- Create: `tests/etl/shared/normalize-text.test.ts`
- Create: `src/etl/shared/normalize-text.ts`

- [ ] **Step 15.1 : Write the failing test**

```ts
// tests/etl/shared/normalize-text.test.ts
import { describe, it, expect } from "vitest";
import { normalizeText, titleCaseFr } from "@/etl/shared/normalize-text.js";

describe("normalizeText", () => {
  it("trims whitespace", () => {
    expect(normalizeText("  hello  ")).toBe("hello");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeText("a   b\t\tc")).toBe("a b c");
  });

  it("normalizes to NFC", () => {
    const decomposed = "é"; // é
    const composed = "é";
    expect(normalizeText(decomposed)).toBe(composed);
  });

  it("strips zero-width and BOM", () => {
    expect(normalizeText("﻿hello​world")).toBe("helloworld");
  });

  it("returns empty string for nullish via wrapper", () => {
    expect(normalizeText("")).toBe("");
  });
});

describe("titleCaseFr", () => {
  it("title-cases simple names", () => {
    expect(titleCaseFr("jean dupont")).toBe("Jean Dupont");
  });

  it("keeps French particles lowercase", () => {
    expect(titleCaseFr("jean de la fontaine")).toBe("Jean de la Fontaine");
  });

  it("handles apostrophe particle", () => {
    expect(titleCaseFr("alice d'arc")).toBe("Alice d'Arc");
  });

  it("handles hyphenated names", () => {
    expect(titleCaseFr("jean-pierre dupont")).toBe("Jean-Pierre Dupont");
  });
});
```

- [ ] **Step 15.2 : Run test, expect failure**

Run: `npm test -- normalize-text`
Expected: FAIL with module-not-found or undefined export.

- [ ] **Step 15.3 : Write `src/etl/shared/normalize-text.ts`**

```ts
const INVISIBLE_RE = /[​‌‍‎‏﻿]/g;
const WHITESPACE_RE = /\s+/g;
const PARTICLES = new Set(["de", "du", "des", "la", "le", "les", "et"]);

export function normalizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

function capFirst(word: string): string {
  if (word.length === 0) return word;
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

function capitalizeToken(token: string, isFirst: boolean): string {
  // Handle apostrophe-bound particles: "d'Arc" -> particle "d", name "Arc"
  const apos = token.indexOf("'");
  if (apos > 0 && apos < token.length - 1) {
    const left = token.slice(0, apos).toLowerCase();
    const right = token.slice(apos + 1);
    if (left.length <= 2) {
      return `${left}'${capFirst(right)}`;
    }
  }

  // Hyphenated: each segment capitalized
  if (token.includes("-")) {
    return token
      .split("-")
      .map((seg) => capFirst(seg))
      .join("-");
  }

  const lower = token.toLowerCase();
  if (!isFirst && PARTICLES.has(lower)) return lower;
  return capFirst(token);
}

export function titleCaseFr(input: string): string {
  const cleaned = normalizeText(input);
  return cleaned
    .split(" ")
    .map((token, i) => capitalizeToken(token, i === 0))
    .join(" ");
}
```

- [ ] **Step 15.4 : Run test, expect pass**

Run: `npm test -- normalize-text`
Expected: all 9 tests PASS.

- [ ] **Step 15.5 : Commit**

```bash
git add tests/etl/shared/normalize-text.test.ts src/etl/shared/normalize-text.ts
git commit -m "feat(etl): normalize-text utility with title-case fr"
```

---

### Task 16 : `parse-date` (TDD)

**Files:**
- Create: `tests/etl/shared/parse-date.test.ts`
- Create: `src/etl/shared/parse-date.ts`

- [ ] **Step 16.1 : Write the failing test**

```ts
// tests/etl/shared/parse-date.test.ts
import { describe, it, expect } from "vitest";
import { parseFfhbDate, parseFfhbDateTime } from "@/etl/shared/parse-date.js";

describe("parseFfhbDate", () => {
  it("parses DD/MM/YYYY", () => {
    const d = parseFfhbDate("15/03/2026");
    expect(d.toISOString().slice(0, 10)).toBe("2026-03-15");
  });

  it("returns null for invalid", () => {
    expect(parseFfhbDate("not a date")).toBeNull();
  });

  it("returns null for empty", () => {
    expect(parseFfhbDate("")).toBeNull();
  });
});

describe("parseFfhbDateTime", () => {
  it("parses DD/MM/YYYY HH:mm as UTC", () => {
    const d = parseFfhbDateTime("15/03/2026 18:30");
    expect(d!.value.toISOString()).toBe("2026-03-15T18:30:00.000Z");
    expect(d!.heure_estimee).toBe(false);
  });

  it("flags estimated when only date provided", () => {
    const d = parseFfhbDateTime("15/03/2026");
    expect(d!.value.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(d!.heure_estimee).toBe(true);
  });

  it("returns null on garbage", () => {
    expect(parseFfhbDateTime("xx/yy/zzzz")).toBeNull();
  });
});
```

- [ ] **Step 16.2 : Run test, expect failure**

Run: `npm test -- parse-date`
Expected: FAIL.

- [ ] **Step 16.3 : Write `src/etl/shared/parse-date.ts`**

```ts
import { parse } from "date-fns";

const DATE_FMT = "dd/MM/yyyy";
const DATETIME_FMT = "dd/MM/yyyy HH:mm";

export function parseFfhbDate(input: string): Date | null {
  if (!input || input.trim().length === 0) return null;
  const d = parse(input.trim(), DATE_FMT, new Date(Date.UTC(2000, 0, 1)));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

export interface ParsedDateTime {
  value: Date;
  heure_estimee: boolean;
}

export function parseFfhbDateTime(input: string): ParsedDateTime | null {
  if (!input || input.trim().length === 0) return null;
  const trimmed = input.trim();
  const hasTime = /\d{2}:\d{2}/.test(trimmed);
  const fmt = hasTime ? DATETIME_FMT : DATE_FMT;
  const d = parse(trimmed, fmt, new Date(Date.UTC(2000, 0, 1)));
  if (Number.isNaN(d.getTime())) return null;
  const value = hasTime
    ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()))
    : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return { value, heure_estimee: !hasTime };
}
```

- [ ] **Step 16.4 : Run test, expect pass**

Run: `npm test -- parse-date`
Expected: all 6 tests PASS.

- [ ] **Step 16.5 : Commit**

```bash
git add tests/etl/shared/parse-date.test.ts src/etl/shared/parse-date.ts
git commit -m "feat(etl): parse-date utility"
```

---

### Task 17 : `parse-saison` (TDD)

**Files:**
- Create: `tests/etl/shared/parse-saison.test.ts`
- Create: `src/etl/shared/parse-saison.ts`

- [ ] **Step 17.1 : Write the failing test**

```ts
// tests/etl/shared/parse-saison.test.ts
import { describe, it, expect } from "vitest";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";

describe("canonicalizeSaison", () => {
  it("accepts already canonical", () => {
    expect(canonicalizeSaison("2025-2026")).toBe("2025-2026");
  });

  it("accepts slash separator", () => {
    expect(canonicalizeSaison("2025/2026")).toBe("2025-2026");
  });

  it("accepts short form", () => {
    expect(canonicalizeSaison("25-26")).toBe("2025-2026");
  });

  it("rejects non-consecutive years", () => {
    expect(() => canonicalizeSaison("2025-2027")).toThrow();
  });

  it("rejects garbage", () => {
    expect(() => canonicalizeSaison("foo")).toThrow();
  });
});
```

- [ ] **Step 17.2 : Run test, expect failure**

Run: `npm test -- parse-saison`
Expected: FAIL.

- [ ] **Step 17.3 : Write `src/etl/shared/parse-saison.ts`**

```ts
import { ValidationError } from "@/lib/errors.js";

const LONG_RE = /^(\d{4})[-\/](\d{4})$/;
const SHORT_RE = /^(\d{2})[-\/](\d{2})$/;

export function canonicalizeSaison(input: string): string {
  const trimmed = input.trim();
  const longMatch = LONG_RE.exec(trimmed);
  if (longMatch) {
    const a = Number(longMatch[1]);
    const b = Number(longMatch[2]);
    if (b !== a + 1) {
      throw new ValidationError(`Saison non consécutive: ${trimmed}`);
    }
    return `${a}-${b}`;
  }

  const shortMatch = SHORT_RE.exec(trimmed);
  if (shortMatch) {
    const a = 2000 + Number(shortMatch[1]);
    const b = 2000 + Number(shortMatch[2]);
    if (b !== a + 1) {
      throw new ValidationError(`Saison non consécutive: ${trimmed}`);
    }
    return `${a}-${b}`;
  }

  throw new ValidationError(`Format saison non reconnu: ${trimmed}`);
}
```

- [ ] **Step 17.4 : Run test, expect pass**

Run: `npm test -- parse-saison`
Expected: all 5 tests PASS.

- [ ] **Step 17.5 : Commit**

```bash
git add tests/etl/shared/parse-saison.test.ts src/etl/shared/parse-saison.ts
git commit -m "feat(etl): parse-saison utility"
```

---

## Phase 5 — Pilot scraper: clubs

### Task 18 : Club Zod schema + HTML parser

**Files:**
- Create: `src/schemas/club.schema.ts`
- Create: `src/scrapers/ffhandball/clubs.scraper.ts`
- Create: `tests/fixtures/ffhandball-clubs-listing.html`
- Create: `tests/scrapers/clubs.scraper.test.ts`

> **IMPORTANT** : Le sélecteur CSS utilisé ci-dessous (`tr.club-row`) est un **placeholder structurel pour le test**. Avant le premier scrape live, l'engineer doit **inspecter la vraie page** sur ffhandball.fr, identifier les vrais sélecteurs, et adapter la fixture + le parser. Cette tâche livre le squelette ; la fixture utilisée ici est volontairement contrôlée.

- [ ] **Step 18.1 : Write the fixture `tests/fixtures/ffhandball-clubs-listing.html`**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Clubs</title></head>
<body>
  <table class="clubs-table">
    <thead>
      <tr><th>ID</th><th>Nom</th><th>Ville</th><th>Département</th></tr>
    </thead>
    <tbody>
      <tr class="club-row" data-id-ffhb="6275001">
        <td class="id">6275001</td>
        <td class="nom">  HBC Trifouilly-sur-Mer  </td>
        <td class="ville">Trifouilly</td>
        <td class="dept">75</td>
      </tr>
      <tr class="club-row" data-id-ffhb="6275002">
        <td class="id">6275002</td>
        <td class="nom">Hand Ball Club d'Ailleurs</td>
        <td class="ville">Ailleurs</td>
        <td class="dept">2A</td>
      </tr>
    </tbody>
  </table>
</body>
</html>
```

- [ ] **Step 18.2 : Write `src/schemas/club.schema.ts`**

```ts
import { z } from "zod";

export const rawClubPayloadSchema = z.object({
  id_ffhb: z.string().regex(/^\d+$/, "id_ffhb must be digits"),
  nom: z.string().min(1),
  ville: z.string().optional(),
  departement_code: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional(),
  source_url: z.string().url(),
});

export type RawClubPayload = z.infer<typeof rawClubPayloadSchema>;
```

- [ ] **Step 18.3 : Write the failing test `tests/scrapers/clubs.scraper.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/ffhandball-clubs-listing.html", import.meta.url),
);

describe("parseClubsListing", () => {
  it("extracts clubs from listing HTML", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const baseUrl = "https://www.ffhandball.fr/clubs";
    const result = parseClubsListing(html, baseUrl);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id_ffhb: "6275001",
      nom: "HBC Trifouilly-sur-Mer",
      ville: "Trifouilly",
      departement_code: "75",
      source_url: baseUrl,
    });
    expect(result[1]?.departement_code).toBe("2A");
  });

  it("returns empty array on empty HTML", () => {
    expect(parseClubsListing("<html></html>", "https://x.test")).toEqual([]);
  });
});
```

- [ ] **Step 18.4 : Run test, expect failure**

Run: `npm test -- clubs.scraper`
Expected: FAIL (module not found).

- [ ] **Step 18.5 : Write `src/scrapers/ffhandball/clubs.scraper.ts`**

```ts
import * as cheerio from "cheerio";
import { rawClubPayloadSchema, type RawClubPayload } from "@/schemas/club.schema.js";

export function parseClubsListing(html: string, sourceUrl: string): RawClubPayload[] {
  const $ = cheerio.load(html);
  const rows: RawClubPayload[] = [];

  $("tr.club-row").each((_, el) => {
    const $row = $(el);
    const id_ffhb = ($row.attr("data-id-ffhb") ?? $row.find("td.id").text()).trim();
    const nom = $row.find("td.nom").text().trim().replace(/\s+/g, " ");
    const ville = $row.find("td.ville").text().trim() || undefined;
    const dept = $row.find("td.dept").text().trim() || undefined;

    const candidate = {
      id_ffhb,
      nom,
      ville,
      departement_code: dept,
      source_url: sourceUrl,
    };
    const parsed = rawClubPayloadSchema.safeParse(candidate);
    if (parsed.success) {
      rows.push(parsed.data);
    }
  });

  return rows;
}
```

- [ ] **Step 18.6 : Run test, expect pass**

Run: `npm test -- clubs.scraper`
Expected: 2 tests PASS.

- [ ] **Step 18.7 : Commit**

```bash
git add src/schemas/ src/scrapers/ffhandball/ tests/fixtures/ tests/scrapers/
git commit -m "feat(scrapers): clubs parser for ffhandball.fr with fixture test"
```

---

### Task 19 : CLI — `scrape` command

**Files:**
- Create: `src/cli/scrape.ts`

- [ ] **Step 19.1 : Write `src/cli/scrape.ts`**

```ts
import { parseArgs } from "node:util";
import { logger } from "@/lib/logger.js";
import { closePool } from "@/db/client.js";
import { fetchHtml } from "@/scrapers/shared/http-client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";

interface CliArgs {
  entity: string;
  saison: string;
  url?: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
      url: { type: "string" },
    },
  });
  if (!values.entity) throw new Error("--entity required");
  if (!values.saison) throw new Error("--saison required");
  return {
    entity: values.entity,
    saison: canonicalizeSaison(values.saison),
    url: values.url,
  };
}

async function scrapeClubs(saison: string, url: string): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "clubs",
    saison,
  });
  logger.info({ run_id: run.id, url }, "starting clubs scrape");

  try {
    const res = await fetchHtml(url);
    await run.incrementPages(1);
    const clubs = parseClubsListing(res.body, res.url);
    logger.info({ count: clubs.length }, "parsed clubs");

    let inserted = 0;
    let duplicates = 0;
    for (const club of clubs) {
      const { inserted: wasNew } = await insertRaw("clubs", {
        scrape_run_id: run.id,
        source_url: club.source_url,
        source_site: "ffhandball.fr",
        natural_key: club.id_ffhb,
        payload: club,
        saison,
        http_status: res.status,
      });
      if (wasNew) inserted++;
      else duplicates++;
    }
    logger.info({ inserted, duplicates }, "raw inserts done");
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.entity !== "clubs") {
    throw new Error(`unknown entity: ${args.entity} (only 'clubs' implemented in pilot)`);
  }
  const url = args.url ?? "https://www.ffhandball.fr/clubs";
  await scrapeClubs(args.saison, url);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    logger.fatal({ err }, "fatal");
    await closePool();
    process.exit(1);
  });
```

- [ ] **Step 19.2 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 19.3 : Smoke test with a `file://` URL (no network)**

The CLI as written fetches via `fetchHtml` which uses `fetch()`. Native `fetch` does not support `file://` — skip live test here. Smoke test happens in the integration test (Task 23).

- [ ] **Step 19.4 : Commit**

```bash
git add src/cli/scrape.ts
git commit -m "feat(cli): scrape command for clubs"
```

---

## Phase 6 — Pilot ETL: clubs

### Task 20 : `resolve-fk` helper

**Files:**
- Create: `src/etl/shared/resolve-fk.ts`
- Create: `tests/etl/shared/resolve-fk.test.ts`

- [ ] **Step 20.1 : Write the failing test**

```ts
// tests/etl/shared/resolve-fk.test.ts
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { query, closePool } from "@/db/client.js";
import { resolveDepartementId } from "@/etl/shared/resolve-fk.js";

describe("resolveDepartementId", () => {
  afterAll(async () => {
    await closePool();
  });

  it("returns id for existing dept code", async () => {
    const r = await query<{ id: number }>(
      `SELECT id FROM core.departements WHERE code = '75'`,
    );
    const expected = r.rows[0]!.id;
    const got = await resolveDepartementId("75");
    expect(got).toBe(expected);
  });

  it("returns null for unknown dept code", async () => {
    expect(await resolveDepartementId("999")).toBeNull();
  });

  it("returns null for nullish input", async () => {
    expect(await resolveDepartementId(undefined)).toBeNull();
  });
});
```

- [ ] **Step 20.2 : Run test, expect failure**

Run: `npm test -- resolve-fk`
Expected: FAIL (module not found).

- [ ] **Step 20.3 : Write `src/etl/shared/resolve-fk.ts`**

```ts
import { query } from "@/db/client.js";

export async function resolveDepartementId(
  code: string | null | undefined,
): Promise<number | null> {
  if (!code) return null;
  const res = await query<{ id: number }>(
    `SELECT id FROM core.departements WHERE code = $1 LIMIT 1`,
    [code],
  );
  return res.rows[0]?.id ?? null;
}

export async function resolveLigueIdFromDept(
  dept_id: number | null,
): Promise<number | null> {
  if (dept_id === null) return null;
  const res = await query<{ ligue_id: number | null }>(
    `SELECT ligue_id FROM core.departements WHERE id = $1`,
    [dept_id],
  );
  return res.rows[0]?.ligue_id ?? null;
}
```

- [ ] **Step 20.4 : Run test, expect pass**

Run: `npm test -- resolve-fk`
Expected: 3 tests PASS.

- [ ] **Step 20.5 : Commit**

```bash
git add src/etl/shared/resolve-fk.ts tests/etl/shared/resolve-fk.test.ts
git commit -m "feat(etl): resolve-fk for departement and ligue"
```

---

### Task 21 : Clubs ETL function

**Files:**
- Create: `src/etl/clubs.etl.ts`

- [ ] **Step 21.1 : Write `src/etl/clubs.etl.ts`**

```ts
import { query } from "@/db/client.js";
import { rawClubPayloadSchema, type RawClubPayload } from "@/schemas/club.schema.js";
import { normalizeText, titleCaseFr } from "@/etl/shared/normalize-text.js";
import { resolveDepartementId, resolveLigueIdFromDept } from "@/etl/shared/resolve-fk.js";
import { logger } from "@/lib/logger.js";

interface RawClubRow {
  id: number;
  natural_key: string;
  payload: unknown;
}

interface EtlReport {
  etl_run_id: number;
  rows_read: number;
  rows_validated: number;
  rows_rejected: number;
  rows_inserted: number;
  rows_updated: number;
  rows_noop: number;
  warnings_count: number;
}

export async function runClubsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('clubs', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report = {
    etl_run_id,
    rows_read: 0,
    rows_validated: 0,
    rows_rejected: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_noop: 0,
    warnings_count: 0,
  };

  try {
    const rawRows = await query<RawClubRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.clubs
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawClubPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets
             (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'clubs',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawClubPayload = parsed.data;
      const nom = titleCaseFr(p.nom);
      const ville = p.ville ? titleCaseFr(p.ville) : null;
      const dept_id = await resolveDepartementId(p.departement_code);
      if (p.departement_code && dept_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1, 'clubs', $2, $3)`,
          [etl_run_id, p.id_ffhb, `dept ${p.departement_code} introuvable`],
        );
        report.warnings_count++;
      }
      const ligue_id = await resolveLigueIdFromDept(dept_id);

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.clubs (id_ffhb, nom, ville, departement_id, ligue_id, last_seen_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom = EXCLUDED.nom,
             ville = EXCLUDED.ville,
             departement_id = EXCLUDED.departement_id,
             ligue_id = EXCLUDED.ligue_id,
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.clubs.nom IS DISTINCT FROM EXCLUDED.nom
                 OR core.clubs.ville IS DISTINCT FROM EXCLUDED.ville
                 OR core.clubs.departement_id IS DISTINCT FROM EXCLUDED.departement_id
                 OR core.clubs.ligue_id IS DISTINCT FROM EXCLUDED.ligue_id
               THEN now()
               ELSE core.clubs.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.id_ffhb, nom, ville, dept_id, ligue_id],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(),
             status = 'success',
             rows_read = $2,
             rows_validated = $3,
             rows_rejected = $4,
             rows_inserted = $5,
             rows_updated = $6,
             rows_noop = $7,
             warnings_count = $8
         WHERE id = $1`,
      [
        etl_run_id,
        report.rows_read,
        report.rows_validated,
        report.rows_rejected,
        report.rows_inserted,
        report.rows_updated,
        report.rows_noop,
        report.warnings_count,
      ],
    );

    logger.info(report, "clubs ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'failed', error_message = $2
         WHERE id = $1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
```

- [ ] **Step 21.2 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 21.3 : Commit**

```bash
git add src/etl/clubs.etl.ts
git commit -m "feat(etl): clubs ETL from raw to core with rejets and warnings"
```

---

### Task 22 : CLI — `etl` command

**Files:**
- Create: `src/cli/etl.ts`

- [ ] **Step 22.1 : Write `src/cli/etl.ts`**

```ts
import { parseArgs } from "node:util";
import { logger } from "@/lib/logger.js";
import { closePool } from "@/db/client.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";

interface CliArgs {
  entity: string;
  saison: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
    },
  });
  if (!values.entity) throw new Error("--entity required");
  if (!values.saison) throw new Error("--saison required");
  return { entity: values.entity, saison: canonicalizeSaison(values.saison) };
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.entity !== "clubs") {
    throw new Error(`unknown entity: ${args.entity} (only 'clubs' implemented in pilot)`);
  }
  const report = await runClubsEtl(args.saison);
  logger.info(report, "etl finished");
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    logger.fatal({ err }, "fatal");
    await closePool();
    process.exit(1);
  });
```

- [ ] **Step 22.2 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 22.3 : Commit**

```bash
git add src/cli/etl.ts
git commit -m "feat(cli): etl command for clubs"
```

---

### Task 23 : End-to-end integration test

**Files:**
- Create: `tests/integration/clubs-end-to-end.test.ts`

- [ ] **Step 23.1 : Write the integration test**

```ts
// tests/integration/clubs-end-to-end.test.ts
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, closePool } from "@/db/client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubsListing } from "@/scrapers/ffhandball/clubs.scraper.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/ffhandball-clubs-listing.html", import.meta.url),
);
const SAISON = "2025-2026";
const TEST_IDS = ["6275001", "6275002"];

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM core.etl_warnings WHERE natural_key = ANY($1::text[])`,
    [TEST_IDS],
  );
  await query(
    `DELETE FROM core.etl_rejets WHERE natural_key = ANY($1::text[])`,
    [TEST_IDS],
  );
  await query(`DELETE FROM core.clubs WHERE id_ffhb = ANY($1::text[])`, [TEST_IDS]);
  await query(
    `DELETE FROM raw.clubs WHERE natural_key = ANY($1::text[]) AND saison = $2`,
    [TEST_IDS, SAISON],
  );
  await query(
    `DELETE FROM raw.scrape_runs WHERE scraper_name = 'clubs' AND saison = $1
       AND id NOT IN (SELECT scrape_run_id FROM raw.clubs)`,
    [SAISON],
  );
}

describe("clubs end-to-end", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("scrape (fixture) → raw → ETL → core, idempotent", async () => {
    // Round 1
    const html = readFileSync(FIXTURE, "utf8");
    const clubs = parseClubsListing(html, "https://www.ffhandball.fr/clubs");
    expect(clubs).toHaveLength(2);

    const run = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "clubs",
      saison: SAISON,
    });
    for (const c of clubs) {
      await insertRaw("clubs", {
        scrape_run_id: run.id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.id_ffhb,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    await run.finishSuccess();

    const r1 = await runClubsEtl(SAISON);
    expect(r1.rows_read).toBe(2);
    expect(r1.rows_validated).toBe(2);
    expect(r1.rows_rejected).toBe(0);
    expect(r1.rows_inserted).toBe(2);
    expect(r1.rows_updated).toBe(0);

    const core = await query<{ id_ffhb: string; nom: string }>(
      `SELECT id_ffhb, nom FROM core.clubs WHERE id_ffhb = ANY($1::text[]) ORDER BY id_ffhb`,
      [TEST_IDS],
    );
    expect(core.rows.map((r) => r.id_ffhb)).toEqual(["6275001", "6275002"]);
    expect(core.rows[0]!.nom).toBe("HBC Trifouilly-sur-Mer");

    // Round 2 — replay should be idempotent (no inserts, no updates because data unchanged)
    const run2 = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "clubs",
      saison: SAISON,
    });
    for (const c of clubs) {
      await insertRaw("clubs", {
        scrape_run_id: run2.id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.id_ffhb,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    await run2.finishSuccess();

    const r2 = await runClubsEtl(SAISON);
    expect(r2.rows_read).toBe(2);
    expect(r2.rows_inserted).toBe(0);
    expect(r2.rows_updated).toBe(0);
    expect(r2.rows_noop).toBe(2);
  });
});
```

- [ ] **Step 23.2 : Run integration test**

Run: `npm test -- clubs-end-to-end`
Expected: 1 test PASS.

- [ ] **Step 23.3 : Commit**

```bash
git add tests/integration/clubs-end-to-end.test.ts
git commit -m "test: end-to-end clubs scrape → raw → ETL → core, idempotent"
```

---

## Phase 7 — Documentation

### Task 24 : README and runbook

**Files:**
- Create: `README.md`
- Create: `docs/runbook.md`

- [ ] **Step 24.1 : Write `README.md`**

````markdown
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
````

- [ ] **Step 24.2 : Write `docs/runbook.md`**

````markdown
# Runbook

## Lancer un scrape

```bash
npm run scrape -- --entity=<entity> --saison=YYYY-YYYY [--url=...]
```

Le scraper :
1. Ouvre un `scrape_run` dans `raw.scrape_runs`
2. Récupère les pages avec rate-limit (cf. `SCRAPE_RATE_LIMIT_MS`)
3. Parse, valide via Zod, insère en `raw.<entity>`
4. Marque le run `success` / `failed` / `partial`

## Lancer un ETL

```bash
npm run etl -- --entity=<entity> --saison=YYYY-YYYY
```

L'ETL :
1. Sélectionne la version la plus récente par `(natural_key, saison)`
2. Valide (Zod), rejet → `core.etl_rejets`
3. Normalise (texte, dates, FKs)
4. UPSERT idempotent vers `core.<entity>`
5. Rapport dans `core.etl_runs`

## Inspecter les rejets / warnings

```sql
SELECT * FROM core.etl_runs ORDER BY started_at DESC LIMIT 10;

SELECT entity, reason, natural_key, payload
  FROM core.etl_rejets
  WHERE etl_run_id = <id>;

SELECT entity, natural_key, message
  FROM core.etl_warnings
  WHERE etl_run_id = <id>;
```

## Rejouer un ETL après bug de nettoyage

```sql
TRUNCATE core.clubs CASCADE;
```

Puis :
```bash
npm run etl -- --entity=clubs --saison=2025-2026
```

Les données `raw.clubs` ne sont pas touchées — pas besoin de rescraper.

## Reset complet de la base

```bash
npm run db:reset       # ⚠️ drop le volume Docker
npm run db:migrate
npm run db:seed
```

## Ajouter une nouvelle saison

```sql
INSERT INTO core.saisons (saison_code, date_debut, date_fin)
VALUES ('2026-2027', '2026-07-01', '2027-06-30');
```
````

- [ ] **Step 24.3 : Commit**

```bash
git add README.md docs/runbook.md
git commit -m "docs: README and runbook"
```

---

## Verification finale

- [ ] **Run the full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Verify DB state**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "
SELECT
  (SELECT count(*) FROM core.saisons)       AS saisons,
  (SELECT count(*) FROM core.ligues)        AS ligues,
  (SELECT count(*) FROM core.departements)  AS departements,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='raw')  AS raw_tables,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='core') AS core_tables;
"
```
Expected: 3 saisons, 18 ligues, 101 départements, 10 raw tables, 20 core tables.

---

## Next steps (hors-scope de ce plan)

Une fois ce pilote livré et stabilisé, chaque entité supplémentaire suit le même
template :

1. Brainstorming léger sur le scraping de l'entité (URL, sélecteurs, particularités)
2. Plan dédié réutilisant les phases 5 + 6 (Zod schema, scraper, ETL, test)
3. Itération sur le schéma `core` (ajout/retrait de colonnes selon les données réelles)

Ordre suggéré (du plus simple au plus dépendant) :
1. `salles` (référentiel pur)
2. `competitions` + `poules` (dépend de saisons)
3. `equipes` + `engagements` (dépend de clubs + poules)
4. `joueurs` + `licences` (dépend de clubs)
5. `arbitres` (dépend de clubs)
6. `matchs` (dépend de poules + équipes + salles)
7. `match_compositions` + `match_officiels` (dépend de matchs + joueurs/arbitres)
8. `classements` (dépend de poules + équipes)
