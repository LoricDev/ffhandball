# BOOTSTRAP — Recréer un projet « pipeline de données + API » de zéro

Ce guide capture **la méthode** et **l'architecture** qui ont produit `ffhandball`, pour
les rejouer sur n'importe quel autre projet du même type : *scraper une source externe →
stocker en brut → normaliser → exposer une API HTTP*.

Il ne contient pas de code à copier-coller intégralement : il décrit le **savoir-faire**, les
**conventions** et une **checklist**. Les extraits sont là pour montrer le pattern, pas pour
être recopiés tels quels.

---

## 1. La méthode (le plus important)

Le projet n'a pas été codé « en vrac ». Chaque entité (clubs, matchs, classements…) est passée
par **la même boucle**, une feature à la fois. C'est ce qui rend le travail rapide et fiable.

```
  IDÉE / NOUVELLE ENTITÉ
   │
   ├─▶ 1. brainstorming           questions une par une → choix d'approche
   │                              └─ écrit  docs/superpowers/specs/<date>-<feature>-design.md
   │
   ├─▶ 2. writing-plans           plan tâche par tâche (TDD, fichiers exacts, commandes)
   │                              └─ écrit  docs/superpowers/plans/<date>-<feature>.md
   │
   └─▶ 3. subagent-driven-development
                                  1 sous-agent par tâche
                                  → review « conformité au spec » puis « qualité du code »
                                  → commits fréquents
```

**Règles d'or** (valables pour tout projet) :

- **YAGNI** : on n'ajoute une entité/un endpoint que quand il y a un besoin réel.
- **Une entité = un cycle complet** spec → plan → exécution. Ne pas tout concevoir d'un coup.
- **TDD** : test rouge → implémentation minimale → vert → commit.
- **DRY** : la logique commune va dans `*/shared/`.
- **Commits petits et fréquents**, messages conventionnels (`feat:`, `fix:`, `chore:`…).

> Sur ce repo : 9 specs + 9 plans dans `docs/superpowers/`. Chacun est un exemple concret à relire.

---

## 2. Architecture : deux schémas, trois étapes

```
   SOURCE EXTERNE                 raw.*  (append-only)            core.*  (normalisé)
   (site web, API, PDF)     ┌──────────────────────────┐   ┌──────────────────────────┐
        │                   │  scrape_runs              │   │  référentiels (saisons…)  │
        │  1. SCRAPE        │  <entité>  (payload JSONB)│   │  entités métier (FK)      │
        └──────────────────▶│  natural_key + hash       │   │  etl_runs / rejets /      │
                            └────────────┬─────────────┘   │  warnings (observabilité) │
                                         │  2. ETL           └────────────┬─────────────┘
                                         └─────────────────────────────────┘
                                                                          │  3. API
                                                                          ▼
                                                              HTTP (Hono + OpenAPI)
```

### Principes

1. **`raw.*` = vérité brute, append-only.** On stocke le payload tel que scrapé (`jsonb`) +
   un `natural_key` (identifiant stable côté source) + un `payload_hash` (sha256). On
   **n'écrase jamais** : on ré-insère seulement si le hash a changé (dédup). Rejouer un scrape
   est donc sans risque.
2. **`core.*` = données normalisées** avec vraies colonnes, contraintes et clés étrangères.
   Alimenté **uniquement** par l'ETL, jamais par le scraper.
3. **3 étapes découplées et idempotentes** : `scrape` (réseau → raw), `etl` (raw → core),
   `api` (core → HTTP). Chacune se relance seule sans casser les autres.
4. **Observabilité ETL** : chaque run écrit dans `core.etl_runs` (compteurs), les lignes
   invalides dans `core.etl_rejets`, les anomalies non bloquantes dans `core.etl_warnings`.
5. **Validation aux frontières** avec Zod : le payload `raw` est validé à l'entrée de l'ETL
   (`safeParse` → rejet si invalide) ; les réponses API sont typées par schéma OpenAPI.
6. **Scraping poli** : User-Agent identifiable + rate-limit ≥ 1,5 s par domaine + retry.
7. **Mémoire bornée** : l'ETL lit `raw.*` **par lots** (keyset pagination), jamais tout d'un
   coup — sinon OOM sur gros volumes (leçon vécue, cf. `src/etl/shared/iterate-raw-batched.ts`).

---

## 3. Stack technique

| Besoin | Choix | Pourquoi |
|---|---|---|
| Runtime | **Node 20** (ESM), **tsx** | pas d'étape de build, TS exécuté direct |
| Langage | **TypeScript** strict | path alias `@/` |
| Package manager | **pnpm** (corepack) | rapide, lockfile strict |
| DB | **Postgres 16** via Docker Compose | JSONB + GIN pour `raw`, SQL riche pour `core` |
| Accès DB | **pg** (Pool) | pas d'ORM : SQL explicite, contrôle total |
| Validation | **Zod** | schémas = source de vérité des types |
| Scraping | **fetch** natif + **cheerio** (HTML) / **pdf-parse** (PDF) + **p-retry** | léger |
| API | **Hono** + `@hono/zod-openapi` + `@hono/swagger-ui` | OpenAPI auto + Swagger |
| Logs | **pino** (+ pino-pretty en dev) | structuré JSON |
| Tests | **Vitest** | rapide, ESM natif |

---

## 4. Squelette de projet

```
projet/
├── package.json            scripts: typecheck test scrape etl api db:up/migrate/seed …
├── tsconfig.json           strict + paths { "@/*": ["src/*"] }
├── vitest.config.ts        include tests/**, alias @/
├── docker-compose.yml       postgres:16 + adminer (bind-mount db/data)
├── .env  /  .env.example
├── db/
│   ├── migrations/         0001_*.sql … (numérotées, idempotentes, jouées dans l'ordre)
│   └── seeds/              référentiels initiaux
├── src/
│   ├── config/env.ts       env validée par Zod  ← PLATEFORME
│   ├── db/client.ts        pool + query() + withTransaction()  ← PLATEFORME
│   ├── lib/                logger, errors, (mailer, pdf-parser)  ← PLATEFORME
│   ├── scrapers/
│   │   ├── shared/         http-client, raw-insert, scrape-run  ← PLATEFORME
│   │   └── <source>/       parsers spécifiques au site  ← MÉTIER
│   ├── schemas/            schémas Zod des payloads + entités  ← MÉTIER
│   ├── etl/
│   │   ├── shared/         parse-date, resolve-fk, iterate-raw-batched…  ← PLATEFORME
│   │   └── <entité>.etl.ts raw → core par entité  ← MÉTIER
│   ├── api/                server.ts + routes/ + middleware/ + schemas/  ← mixte
│   └── cli/                scrape.ts, etl.ts, pipeline.ts, status.ts  ← dispatchers
├── deploy/                 install-server, setup-app, systemd, nginx, certbot, cron  ← PLATEFORME
└── docs/                   runbook, INSTALL, DEPLOY, superpowers/{specs,plans}
```

**~70 % est de la PLATEFORME** (réutilisable quasi tel quel). Seuls `scrapers/<source>/`,
`schemas/`, `etl/<entité>.etl.ts` et les routes/migrations métier changent d'un projet à l'autre.

---

## 5. Briques plateforme (patterns à reproduire)

### `src/config/env.ts` — config validée au démarrage
```ts
import { z } from "zod";
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  SCRAPE_USER_AGENT: z.string().min(10),
  SCRAPE_RATE_LIMIT_MS: z.coerce.number().int().min(0).default(1500),
  SCRAPE_RETRY_MAX: z.coerce.number().int().min(0).default(3),
  LOG_LEVEL: z.enum(["trace","debug","info","warn","error","fatal"]).default("info"),
  API_PORT: z.coerce.number().int().default(3000),
  // … (auth API, mail, pagination — ajouter au besoin)
});
export const env = envSchema.parse(process.env);   // throw au boot si une var manque
```

### `src/db/client.ts` — un seul Pool, `query()` + `withTransaction()`
```ts
export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
export async function query<T>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params as never[]);
}
export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); }
}
```

### `raw` : un schéma générique, une table par entité (migration 0001)
Une fonction plpgsql crée chaque table de capture avec le **même contrat** (`natural_key`,
`payload jsonb`, `payload_hash`, `scraped_at`, `saison`, `http_status`) + index GIN sur le payload :
```sql
CREATE TABLE raw.<entité> (
  id bigserial PRIMARY KEY,
  scrape_run_id uuid NOT NULL REFERENCES raw.scrape_runs(id),
  source_url text, source_site text,
  natural_key text NOT NULL,          -- identifiant stable côté source
  payload jsonb NOT NULL, payload_hash text NOT NULL,
  scraped_at timestamptz DEFAULT now(), saison text NOT NULL, http_status integer
);
```

### `src/scrapers/shared/http-client.ts` — scraping poli + retry
Rate-limit **par domaine** (map `domaine → dernier appel`), User-Agent identifiable, `p-retry` :
```ts
const wait = env.SCRAPE_RATE_LIMIT_MS - (Date.now() - lastRequestAt.get(domain) ?? 0);
if (wait > 0) await new Promise(r => setTimeout(r, wait));
// fetch avec headers["User-Agent"] = env.SCRAPE_USER_AGENT, puis pRetry(retries: SCRAPE_RETRY_MAX)
```

### `src/scrapers/shared/raw-insert.ts` — append-only avec dédup par hash
```ts
const payload_hash = sha256(JSON.stringify(payload));
// si (natural_key, saison, payload_hash) existe déjà → noop (inserted:false)
// sinon INSERT … RETURNING id  (inserted:true)
```

### `src/etl/shared/iterate-raw-batched.ts` — lecture par lots (anti-OOM)
Générateur async : `DISTINCT ON (natural_key) … WHERE natural_key > $cursor ORDER BY natural_key,
scraped_at DESC LIMIT $batch`. Curseur strictement croissant → ni doublon, ni saut, mémoire bornée.
**Tout ETL consomme `raw.*` via cet itérateur**, jamais via un `SELECT *` global.

### Le contrat d'un ETL `src/etl/<entité>.etl.ts`
```
1. INSERT core.etl_runs → etl_run_id
2. for await (row of iterateRawBatched("raw.<entité>", saison)):
     a. safeParse(row.payload)  → si KO: INSERT core.etl_rejets ; continue
     b. résoudre les FK (core.*) → si introuvable: INSERT core.etl_warnings ; continue
     c. UPSERT idempotent dans core.<entité> (ON CONFLICT … DO UPDATE)
        (transaction par unité si cascade multi-tables)
3. UPDATE core.etl_runs (compteurs, status='success')   |  catch → status='failed'
```

---

## 6. Conventions

- **Migrations** : `NNNN_description.sql`, numérotées, **idempotentes** (`IF NOT EXISTS`,
  `CREATE OR REPLACE`), jouées dans l'ordre lexical. On n'édite jamais une migration passée :
  on en ajoute une nouvelle.
- **`natural_key`** : identifiant **stable côté source** (id externe, code…). Sert à dédupliquer
  `raw` et à retrouver la dernière version (`DISTINCT ON … ORDER BY scraped_at DESC`).
- **Idempotence partout** : re-scraper = noop si rien n'a changé ; re-ETL = UPSERT.
- **Fichiers focalisés** : une responsabilité par fichier ; quand un fichier grossit, le découper.
- **Tests** : unitaires (parsers/schemas, sans DB) + intégration (end-to-end avec Postgres).
  Sur ce repo : `vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork`
  (les tests DB ne tournent pas en parallèle pour éviter les deadlocks).
- **CLI dispatcher** : `pnpm scrape --entity=X`, `pnpm etl --entity=X`, un `pipeline.ts` qui
  enchaîne tout pour une saison.

---

## 7. Checklist — nouveau projet de zéro

1. `mkdir projet && cd projet && git init && corepack enable pnpm`
2. `pnpm init`, ajouter `"type":"module"`, `"packageManager":"pnpm@<v>"`, Node ≥ 20.
3. Copier la **plateforme** depuis un projet existant : `tsconfig.json`, `vitest.config.ts`,
   `docker-compose.yml`, `src/{config/env,db/client,lib,scrapers/shared,etl/shared}`, `deploy/`.
4. `pnpm add` : `pg zod hono @hono/node-server @hono/zod-openapi @hono/swagger-ui pino pino-pretty p-retry cheerio`
   (+ `pdf-parse` si PDF). Dev : `typescript @types/node @types/pg vitest`.
   `pnpm.onlyBuiltDependencies: ["esbuild"]` dans `package.json` (sinon tsx casse).
5. `.env` : `DATABASE_URL`, `SCRAPE_USER_AGENT` (avec un email de contact), rate-limit.
6. Migration `0001` : schéma `raw` + `scrape_runs` + fonction de création des tables de capture
   + `core.etl_runs/etl_rejets/etl_warnings`. `pnpm db:up && pnpm db:migrate`.
7. **Lancer la boucle méthode** (§1) pour la **1re entité** : brainstorming → spec → plan →
   exécution. Cible : scrape → raw → etl → core → 1 endpoint, testé de bout en bout.
8. Répéter §7 pour chaque entité suivante.
9. Quand c'est stable : adapter `deploy/` (nom du service, domaine) et déployer.

---

## 8. Déploiement clé-en-main

`deploy/` contient tout pour un VPS Ubuntu, à reparamétrer (nom du projet/service, domaine) :

- `deploy-all.sh` → `install-server.sh` (Docker, nvm+Node, pnpm via corepack, nginx, certbot, ufw)
  puis `setup-app.sh` (`.env`, `pnpm install --prod --frozen-lockfile`, DB up+migrate+seed,
  service systemd, HTTPS Let's Encrypt, cron).
- `systemd/*.service.template` : lance l'API via `node --import tsx … server.ts` (pas de build).
- `cron/*.sh` : scrape + ETL planifiés (quotidien / hebdo / mensuel selon la fraîcheur voulue).

Mise à jour : `git pull && pnpm install --prod --frozen-lockfile && pnpm db:migrate && systemctl restart <service>`.

---

*Pour voir la méthode en action, lire n'importe quel couple `docs/superpowers/specs/*-design.md`
+ `docs/superpowers/plans/*.md` : ce sont des exemples complets et datés.*
