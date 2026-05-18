# FFHandball — Pipeline de données : design

**Date :** 2026-05-18
**Statut :** Validé pour implémentation
**Portée :** Schéma de stockage, pipeline de nettoyage, structure du projet

---

## 1. Contexte et objectifs

Construire une base de données nationale du handball français à partir de scrapes des sites publics **ffhandball.fr** et **monclub.ffhandball.fr**, en vue d'exposer plus tard une API.

**Portée des données :**
- Échelle : **nationale** (tous clubs, championnats, joueurs de France)
- Historique : **multi-saison** sans versioning intra-saison (snapshot par saison)
- Entités : clubs, équipes, joueurs/licenciés, matchs, feuilles de match, classements, compétitions/poules, arbitres, salles

**Stack technique :**
- Stockage : **PostgreSQL 16**
- Langage : **Node.js / TypeScript**
- Scraping : Playwright (pages dynamiques) + Cheerio (HTML statique)
- Validation : Zod
- Local : Docker Compose

**Principes directeurs :**
- Idempotence à tous les étages (scrape, ETL)
- `raw` append-only, `core` reconstructible depuis `raw`
- Schéma évolutif piloté par les données réelles : les colonnes seront ajustées
  (ajouts/retraits) au fil des découvertes lors du scraping
- Respect des sites sources : rate-limiting, User-Agent identifiable

---

## 2. Architecture globale

```
┌──────────────────────────────────────────────────────────────────┐
│                  SOURCES (web scraping)                          │
│   ffhandball.fr (public)      monclub.ffhandball.fr (public)     │
└───────────────────┬──────────────────────┬───────────────────────┘
                    │                      │
                    ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                 SCRAPERS (Node.js / TypeScript)                  │
│   Playwright + Cheerio. 1 scraper = 1 type d'entité.             │
│   Sortie = payload JSON. Validation Zod stricte à l'étape ETL ;  │
│   le scraper ne fait qu'une vérification structurelle minimale.  │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼ INSERT JSONB
┌──────────────────────────────────────────────────────────────────┐
│  PostgreSQL — schéma `raw`                                       │
│  raw.clubs, raw.equipes, raw.joueurs, raw.matchs, ...            │
│  Append-only. Source de vérité brute.                            │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼ ETL (Node.js)
┌──────────────────────────────────────────────────────────────────┐
│  PostgreSQL — schéma `core`                                      │
│  Modèle relationnel normalisé, indexé. Cible de l'API future.    │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼ (futur)
┌──────────────────────────────────────────────────────────────────┐
│              API REST/GraphQL (Node.js, plus tard)               │
└──────────────────────────────────────────────────────────────────┘
```

**Principes clés :**

1. **Idempotence.** Scrape et ETL peuvent être rejoués N fois sans duplication
   ni corruption. Chaque entité a une clé naturelle (`id_ffhb`, `numero_licence`,
   ...) qui sert d'ancre pour les UPSERT.
2. **`raw` append-only.** Pas d'`UPDATE`/`DELETE` en exploitation. L'historique
   des captures est conservé.
3. **`core` reconstructible.** Bug dans le nettoyage → `TRUNCATE core.*` +
   replay ETL depuis `raw`, sans rescraper les sites sources.
4. **Séparation processus.** Scraper, ETL, API tournent indépendamment.
5. **Une `scrape_run` par exécution.** Tag UUID + timestamp + saison sur chaque
   payload ; traçabilité totale.

---

## 3. Schéma `raw` (capture brute)

### 3.1 Table de référence

`raw.scrape_runs` — une ligne par lancement de scraper.

| Colonne          | Type            | Description                                                     |
|------------------|-----------------|-----------------------------------------------------------------|
| `id`             | `uuid` PK       | Identifiant unique                                              |
| `started_at`     | `timestamptz`   | Début du scrape                                                 |
| `finished_at`    | `timestamptz?`  | Fin (NULL si en cours / crashé)                                 |
| `source_site`    | `text`          | `'ffhandball.fr'` ou `'monclub.ffhandball.fr'`                  |
| `scraper_name`   | `text`          | Nom du scraper (ex : `'clubs'`)                                 |
| `saison`         | `text`          | Format `'2025-2026'`                                            |
| `status`         | `text`          | `'running'` / `'success'` / `'failed'` / `'partial'`            |
| `pages_scraped`  | `int`           | Compteur                                                        |
| `error_message`  | `text?`         | Si crash                                                        |

### 3.2 Tables de capture (structure uniforme)

Une table par entité scrapée : `raw.clubs`, `raw.equipes`, `raw.joueurs`,
`raw.matchs`, `raw.feuilles_match`, `raw.classements`, `raw.competitions`,
`raw.arbitres`, `raw.salles`. Toutes partagent la structure suivante :

| Colonne          | Type            | Description                                              |
|------------------|-----------------|----------------------------------------------------------|
| `id`             | `bigserial` PK  | Auto-incrémenté                                          |
| `scrape_run_id`  | `uuid` FK       | → `raw.scrape_runs`                                      |
| `source_url`     | `text`          | URL exacte du payload                                    |
| `source_site`    | `text`          | Dénormalisé pour requêtes rapides                        |
| `natural_key`    | `text`          | Clé naturelle extraite tôt (ex : `id_ffhb`)              |
| `payload`        | `jsonb`         | Données brutes parsées                                   |
| `payload_hash`   | `text`          | SHA-256 du payload (déduplication exacte)                |
| `scraped_at`     | `timestamptz`   | `default now()`                                          |
| `saison`         | `text`          | Saison rattachée                                         |
| `http_status`    | `int`           | Code HTTP de la requête                                  |

**Index recommandés :**
- `(natural_key, saison)`
- `(scrape_run_id)`
- `(payload_hash)`
- GIN sur `payload`

> **Note sur `raw.feuilles_match`** : un payload = une feuille de match. Côté
> `core`, ses données sont éclatées dans **trois tables** dérivées :
> `core.matchs` (en-tête : score, statut, date), `core.match_compositions`
> (joueurs alignés et stats), `core.match_officiels` (arbitres et délégués).
> Il n'y a pas de table `core.feuilles_match` ; l'agrégation se reconstitue
> par jointure sur `match_id`.

### 3.3 Règle d'or

**`raw` est append-only.** Pas d'`UPDATE`, pas de `DELETE` en cours
d'exploitation. Si un payload est buggué, on en réinsère un nouveau (plus
récent). L'ETL prendra toujours la version la plus récente par
`(natural_key, saison)`.

---

## 4. Schéma `core` (modèle relationnel)

### 4.1 Conventions transversales

- PK `BIGSERIAL` (surrogate) sur toutes les tables.
- `UNIQUE` sur la clé naturelle pour idempotence des UPSERT.
- Entités saisonnières : colonne `saison_code` FK vers `core.saisons`.
- Audit : `created_at`, `updated_at`, `last_seen_at` partout.

### 4.2 Groupe 1 — Référentiels & géographie

```
core.saisons       (saison_code PK '2025-2026', date_debut, date_fin)
core.ligues        (id, code, nom)
core.departements  (id, code '01'..'976', nom, ligue_id FK)
core.salles        (id, id_ffhb UNIQUE, nom, adresse, code_postal,
                    ville, departement_id FK, capacite)
```

### 4.3 Groupe 2 — Structures sportives

```
core.clubs         (id, id_ffhb UNIQUE, nom, sigle, ville,
                    departement_id FK, ligue_id FK, salle_principale_id FK)

core.competitions  (id, id_ffhb UNIQUE, nom, niveau, sexe, categorie_age,
                    saison_code FK)
                    -- niveau ∈ {national, regional, departemental}
                    -- sexe   ∈ {M, F, mixte}

core.poules        (id, competition_id FK, code, nom, saison_code FK)
                    -- UNIQUE (competition_id, code)

core.equipes       (id, club_id FK, nom_equipe, sexe, categorie_age,
                    saison_code FK)

core.engagements   (equipe_id FK, poule_id FK)   -- N:N, championnat + coupe
```

### 4.4 Groupe 3 — Personnes

```
core.joueurs       (id, numero_licence UNIQUE, nom, prenom,
                    date_naissance, sexe, nationalite)
                    -- entité stable, ne change pas par saison

core.licences      (id, joueur_id FK, club_id FK, saison_code FK,
                    categorie_age, type_licence)
                    -- UNIQUE (joueur_id, saison_code)
                    -- trace les mutations

core.arbitres      (id, numero_licence UNIQUE, nom, prenom, niveau,
                    club_rattachement_id FK?)
```

### 4.5 Groupe 4 — Activité de jeu

```
core.matchs                (id, id_ffhb_match UNIQUE, poule_id FK,
                            equipe_dom_id FK, equipe_ext_id FK,
                            date_heure, salle_id FK,
                            score_dom, score_ext, score_mt_dom, score_mt_ext,
                            statut, journee, feuille_validee BOOL)
                            -- statut ∈ {a_jouer, joue, reporte, annule, forfait}

core.match_compositions    (id, match_id FK, joueur_id FK, equipe_id FK,
                            numero_maillot, titulaire BOOL, capitaine BOOL,
                            gardien BOOL, but_count, exclusion_2min_count,
                            carton_jaune BOOL, carton_rouge BOOL)
                            -- UNIQUE (match_id, joueur_id)

core.match_officiels       (id, match_id FK, arbitre_id FK, role)
                            -- role ∈ {arbitre_1, arbitre_2, delegue,
                            --         observateur, chrono}

core.classements           (poule_id FK, equipe_id FK,
                            position, points, joues, gagnes, nuls, perdus,
                            buts_pour, buts_contre, difference,
                            journee_courante, capture_date)
                            -- PK (poule_id, equipe_id)
                            -- UPSERT à chaque ETL (snapshot)
```

### 4.6 Décisions notables

- **`joueurs` ≠ `licences`** : un joueur existe une fois, sa licence par saison
  capture son club et sa catégorie. Mutations préservées naturellement.
- **`engagements` N:N** : prévoit Championnat + Coupe sans refondre le schéma.
- **`match_compositions` agrège** les stats du match (buts, exclusions) au lieu
  d'une table `match_evenements` minute par minute. Si plus tard la granularité
  minute devient nécessaire, on ajoute une table `match_evenements` sans casser
  l'existant.
- **`classements` = snapshot** : on écrase à chaque ETL. L'historique
  inter-saison est préservé via la `saison` portée par la `poule`.
- **`last_seen_at`** : si une entité n'apparaît plus dans aucun scrape pendant
  N jours, elle peut être flaggée sans être supprimée.

---

## 5. Pipeline de nettoyage (ETL)

### 5.1 Vue d'ensemble

```
raw.<entité>  →  1. Sélection  →  2. Validation  →  3. Normalisation
                                                         │
                                                         ▼
                                                4. Résolution FK
                                                         │
                                                         ▼
                                                5. UPSERT core.<entité>
                                                         │
                                                         ▼
                                                6. Rapport qualité
```

### 5.2 Étape 1 — Sélection

Pour chaque `(natural_key, saison)`, prendre la ligne `raw` la plus récente :

```sql
SELECT DISTINCT ON (natural_key, saison) *
FROM raw.clubs
ORDER BY natural_key, saison, scraped_at DESC;
```

### 5.3 Étape 2 — Validation Zod

Chaque entité possède un schéma Zod dans `src/schemas/`. Toute ligne invalide
est rejetée vers `core.etl_rejets` (avec la raison) — jamais perdue.

### 5.4 Étape 3 — Normalisation

| Problème                            | Règle                                                                                                  |
|-------------------------------------|--------------------------------------------------------------------------------------------------------|
| Encodage (`é → Ã©`)                 | Détection `chardet`, normalisation UTF-8 NFC (`String.normalize('NFC')`)                               |
| Espaces parasites                   | `.trim()` + collapse multiples (`/\s+/g → ' '`)                                                        |
| Casse noms propres                  | Title Case sauf particules (`de`, `du`, `la`, `d'`)                                                    |
| Dates                               | `timestamptz` UTC. Sources `JJ/MM/AAAA[ HH:mm]` → ISO via `date-fns/parse`                             |
| Heure de match manquante            | `00:00:00+00` + flag `heure_estimee = true`                                                            |
| Scores des matchs non joués         | `score_dom = NULL`, `score_ext = NULL`, `statut = 'a_jouer'`                                           |
| Numéros de licence                  | String, zéros de tête préservés, validation regex                                                      |
| Codes postaux                       | String 5 chars, zéro-padding (`'1000'` → `'01000'`)                                                    |
| Numéros de département              | String 2-3 chars (`'2A'`, `'2B'`, `'974'` préservés)                                                   |
| Noms de club avec variantes         | Table `core.alias_clubs (id_ffhb, alias)` pour résoudre les variantes                                  |
| Saisons                             | Canonique `'2025-2026'` (année basse d'abord)                                                          |
| Catégories d'âge                    | Enum `{U11, U13, U15, U17, U18, U20, Seniors, +35, Vétérans}`                                          |
| Sexe                                | Enum `{M, F, mixte}`                                                                                   |
| Caractères invisibles               | Suppression de `\u200B` (zero-width space), `\u00A0` (NBSP), `\uFEFF` (BOM)                              |

### 5.5 Étape 4 — Résolution des FK

`resolveEquipe(natural_key, saison)` :
1. Recherche par clé naturelle dans `core.equipes`.
2. Si absent : résolution floue (nom de club + saison + catégorie).
3. Si échec : placeholder avec `flag_a_reconcilier = true` +
   ligne dans `core.etl_warnings`. L'ETL ne plante jamais sur une FK manquante.

### 5.6 Étape 5 — UPSERT idempotent

```sql
INSERT INTO core.clubs (id_ffhb, nom, ...)
VALUES (...)
ON CONFLICT (id_ffhb) DO UPDATE
SET nom = EXCLUDED.nom,
    ...,
    updated_at = now(),
    last_seen_at = now()
WHERE core.clubs.* IS DISTINCT FROM EXCLUDED.*;
```

La clause `IS DISTINCT FROM` évite de toucher `updated_at` quand rien n'a
changé.

### 5.7 Étape 6 — Rapport qualité

Écriture dans `core.etl_runs` :
- entité traitée, lignes lues / validées / rejetées / upsertées
- répartition inserts / updates / no-op
- nb d'avertissements de FK non résolues
- durée

### 5.8 Politique des doublons et valeurs manquantes

**Doublons :**
- Exact (même `payload_hash`) → ignoré en ETL.
- Sémantique (formes différentes) → résolu par normalisation + UPSERT sur clé naturelle.
- Avec divergence (même clé naturelle, valeurs différentes) → la version la plus
  récente gagne ; l'ancienne reste dans `raw`.

**Valeurs manquantes :**
- Champ obligatoire absent → rejet vers `etl_rejets`.
- Champ optionnel absent → `NULL` (jamais `""` ni `'N/A'`).
- Champ calculable → `GENERATED ALWAYS AS (...) STORED` (ex : différence de
  buts).

---

## 6. Structure du dépôt

```
ffhandball/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example                  # DATABASE_URL, USER_AGENT, etc.
├── .gitignore
├── docker-compose.yml            # Postgres + Adminer pour dev local
│
├── docs/
│   ├── superpowers/specs/        # specs de design
│   ├── architecture.md
│   └── runbook.md
│
├── db/
│   ├── migrations/               # node-pg-migrate
│   │   ├── 0001_create_raw_schema.sql
│   │   ├── 0002_create_core_referentiels.sql
│   │   └── ...
│   ├── seeds/                    # saisons, ligues, départements
│   └── README.md
│
├── src/
│   ├── config/                   # env, constantes
│   ├── db/                       # client Postgres, helpers UPSERT
│   ├── schemas/                  # Zod par entité
│   ├── scrapers/
│   │   ├── ffhandball/
│   │   ├── monclub/
│   │   └── shared/               # HTTP client, rate limit, retry
│   ├── etl/
│   │   ├── shared/               # normalize-text, parse-date, resolve-fk
│   │   └── <entité>.etl.ts
│   ├── cli/                      # commandes Node
│   │   ├── scrape.ts
│   │   ├── etl.ts
│   │   └── inspect-rejets.ts
│   └── lib/                      # logger, erreurs typées
│
├── tests/
│   ├── fixtures/                 # HTML / JSON figés
│   ├── scrapers/
│   ├── etl/
│   └── integration/
│
└── scripts/                      # one-shots dev (analyse, export CSV)
```

---

## 7. Environnement local — `docker-compose.yml`

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
      - ./db/migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ffhandball"]
      interval: 5s

  adminer:
    image: adminer:latest
    container_name: ffhandball-adminer
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
```

**Utilisation :**
```bash
docker compose up -d              # démarre Postgres + Adminer
# Postgres : localhost:5432
# Adminer  : http://localhost:8080
docker compose down               # stop
docker compose down -v            # stop + drop des volumes
```

Le volume `./db/data` persiste la base entre les redémarrages. Le montage de
`./db/migrations` joue les SQL au premier boot. Pour la suite, on utilisera
`node-pg-migrate` côté Node pour les migrations incrémentales.

---

## 8. Conventions de nommage

| Élément                      | Convention                          | Exemple                                  |
|------------------------------|-------------------------------------|------------------------------------------|
| Tables Postgres              | `snake_case`, pluriel, FR           | `core.clubs`, `core.match_compositions`  |
| Colonnes                     | `snake_case`, FR                    | `numero_licence`, `date_heure`           |
| Foreign Keys                 | `<table_cible_au_singulier>_id`     | `club_id`, `equipe_dom_id`               |
| Index                        | `idx_<table>_<colonnes>`            | `idx_clubs_departement_id`               |
| Contraintes UNIQUE           | `uq_<table>_<colonnes>`             | `uq_clubs_id_ffhb`                       |
| Enums (en DB)                | éviter ; préférer `CHECK` + `text`  | `statut text CHECK (statut IN (...))`    |
| Fichiers TS                  | `kebab-case.<role>.ts`              | `clubs.scraper.ts`, `parse-date.ts`      |
| Variables / fonctions TS     | `camelCase`, EN                     | `scrapeClubs()`, `normalizeText()`       |
| Types TS                     | `PascalCase`, EN                    | `Club`, `RawClubPayload`, `ClubInsertDTO`|
| Schémas Zod                  | `<entité>Schema`, EN                | `clubSchema`, `matchSchema`              |
| Migrations                   | `NNNN_<verbe>_<sujet>.sql`          | `0007_add_arbitres_table.sql`            |
| Logs de scrape               | `<saison>_<entity>_<UTC ISO>.log`   | `2025-2026_clubs_2026-05-18T08-30-00Z.log` |

**Langue :** tables/colonnes en **français** (vocabulaire métier FFHB), code TS
en **anglais**, schémas Zod font le pont.

---

## 9. Conventions Git et environnement

**Git :**
- `main` protégée
- Branches : `feat/<entity>-scraper`, `feat/<entity>-etl`, `fix/...`, `chore/...`
- Commits : convention courte (`feat(scraper): add clubs scraper`)

**`.env.example` :**
```
DATABASE_URL=postgresql://ffhandball:ffhandball@localhost:5432/ffhandball
SCRAPE_USER_AGENT="ffhandball-data-bot/0.1 (contact: ...)"
SCRAPE_RATE_LIMIT_MS=1500
SCRAPE_CONCURRENCY=2
SCRAPE_RETRY_MAX=3
LOG_LEVEL=info
```

**Politique de scraping responsable :**
- `User-Agent` identifiant + email de contact
- Respect de `robots.txt` (à vérifier au démarrage)
- Rate-limit minimum **1 req / 1.5 s par domaine**
- Cache local des pages HTML pendant le dev
- Scrapes nocturnes (heures creuses)

---

## 10. Critères de succès

1. Schéma `raw` et `core` créés via migrations versionnées.
2. `docker compose up -d` lance Postgres + Adminer en moins d'une minute.
3. Un scraper de bout en bout (par exemple `clubs`) écrit dans `raw.clubs`,
   l'ETL produit `core.clubs` propre, le rapport ETL liste les rejets/warnings.
4. Rejouer scraper + ETL sur la même page ne crée aucun doublon et n'augmente
   pas `updated_at` si rien n'a changé.
5. Le schéma supporte naturellement l'ajout d'une nouvelle saison sans
   migration (juste un INSERT dans `core.saisons`).

---

## 11. Hors-scope (volontairement exclu)

- L'API REST/GraphQL (sera un projet ultérieur consommant `core`).
- L'évolution intra-saison des classements (sera ajoutable plus tard via une
  table `core.classements_historique` sans casser l'existant).
- Les statistiques agrégées (top buteurs, classements joueurs) — déductibles à
  la lecture, peuvent vivre en vue matérialisée plus tard.
- L'authentification/autorisation API.
- Le déploiement en production (CI/CD, hébergement).
