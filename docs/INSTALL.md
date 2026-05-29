# Installation et configuration

Guide pas-à-pas pour installer le pipeline ffhandball en local (dev) ou sur un serveur.

## Pré-requis

| Composant | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 20 (LTS) | Pour le runtime TypeScript via tsx |
| **Docker Engine** | ≥ 24 | Conteneur Postgres + Adminer |
| **Docker Compose** | v2 (intégré) | `docker compose` (sans tiret) |
| **Git** | ≥ 2.30 | Cloner le repo |
| **OS** | macOS / Linux | Windows non testé (devrait marcher via WSL2) |

Vérifier :

```bash
node --version    # v20.x ou plus
docker --version  # ≥ 24.x
docker compose version
```

## Installation

### 1. Cloner le repo

```bash
git clone https://github.com/LoricDev/ffhandball.git
cd ffhandball
```

### 2. Variables d'environnement

```bash
cp .env.example .env
```

Édite `.env` :

```env
DATABASE_URL=postgresql://ffhandball:ffhandball@localhost:5432/ffhandball

# User-Agent identifiable pour le scraping (recommandé : adresse de contact)
SCRAPE_USER_AGENT=ffhandball-data-bot/0.1 (contact: ton.email@example.com)

# Rate-limit entre requêtes HTTP (ms). 1500 = 1.5 s/req (poli)
SCRAPE_RATE_LIMIT_MS=1500

# Concurrence (1 par défaut — séquentiel)
SCRAPE_CONCURRENCY=1

# Nombre max de retry sur 5xx / timeout
SCRAPE_RETRY_MAX=3

LOG_LEVEL=info
NODE_ENV=development
```

⚠️ **Le `SCRAPE_USER_AGENT` doit identifier ton instance** (politique de scraping FFHandball). Mets une vraie adresse de contact.

### 3. Installation des dépendances

```bash
npm install
```

### 4. Démarrage des conteneurs

```bash
npm run db:up
```

Cela démarre :
- **PostgreSQL 16** sur `localhost:5432` (user/pass `ffhandball`/`ffhandball`)
- **Adminer** sur http://localhost:8081 (UI web pour explorer la DB)

Pour vérifier que Postgres est prêt :

```bash
docker ps | grep ffhandball-postgres
# Doit afficher (healthy)
```

### 5. Migrations et seeds

```bash
npm run db:migrate    # Applique toutes les migrations 0001 → 0017
npm run db:seed       # Charge saisons, ligues, départements
```

Pour vérifier :

```bash
npm run db:psql
\dt core.*        # Doit lister 14 tables (clubs, salles, competitions, ...)
\dt raw.*         # Doit lister 11 raw tables (clubs, salles, matchs, ...)
SELECT * FROM core.saisons;
\q
```

### 6. Tests

```bash
# Suite séquentielle (recommandée — évite les deadlocks Postgres parallèles)
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork

# Suite parallèle (plus rapide mais peut avoir des deadlocks transitoires)
npm test
```

Tous les tests doivent passer (~250 en mode séquentiel à date).

## Premier scrape (smoke test)

Pour vérifier que le pipeline complet fonctionne sur un échantillon minimal :

```bash
# 1. Scrape la liste des clubs (~2326 clubs, ~1 min)
npm run scrape -- --entity=clubs --saison=2025-2026 --url=https://www.ffhandball.fr/clubs

# 2. ETL clubs
npm run etl -- --entity=clubs --saison=2025-2026

# 3. Vérifier
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*) FROM core.clubs;"
# Doit afficher ~2326
```

### Smoke test API

Une fois `core.*` peuplé (même partiellement), lance l'API :

```bash
npm run api
# → API live sur http://localhost:3000
```

Endpoints à tester :
```bash
curl http://localhost:3000/health
curl http://localhost:3000/clubs?q=brest&limit=5
open http://localhost:3000/docs   # Swagger UI interactif
```

## Troubleshooting

### Docker : port 5432 déjà utilisé

Tu as déjà un Postgres local sur 5432. Deux options :

**Option A — Stopper le Postgres local** :
```bash
brew services stop postgresql  # macOS Homebrew
sudo systemctl stop postgresql # Linux
```

**Option B — Changer le port mappé** dans `docker-compose.yml` :
```yaml
ports:
  - "5433:5432"   # ← 5433 au lieu de 5432
```
Et mettre à jour `DATABASE_URL` dans `.env` : `postgresql://...@localhost:5433/...`

### Tests : `pg_isready` échoue / "connection refused"

Postgres pas encore prêt après `db:up`. Attendre 5-10 secondes ou vérifier l'état :
```bash
docker compose ps
# postgres doit être (healthy)
docker logs ffhandball-postgres 2>&1 | tail -20
```

### Tests : deadlocks Postgres parallèles

Vitest lance les fichiers en parallèle par défaut → conflits sur les TRUNCATE. Solution : lance en séquentiel :
```bash
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
```

### Migration : "already exists"

`db:migrate` n'est pas idempotent par défaut, il rejoue toutes les migrations. Les migrations utilisent `IF NOT EXISTS` partout, donc c'est généralement safe. Si erreur :

```bash
# Reset complet (⚠️ drop le volume Docker, perte de toutes les données)
npm run db:reset
npm run db:migrate
npm run db:seed
```

### Scrape : `429 Too Many Requests`

Le serveur ffhandball.fr rate-limite. Augmenter `SCRAPE_RATE_LIMIT_MS` à 2000 ou 3000 dans `.env`.

### Scrape : `ext_saison_id introuvable`

La saison demandée n'existe pas côté ffhandball.fr, ou la page d'accueil compétitions a changé. Vérifier manuellement :
```bash
curl -s -A "$SCRAPE_USER_AGENT" https://www.ffhandball.fr/competitions/ | grep ext_saison_id
```

### API : port 3000 déjà utilisé

Modifier `API_PORT` dans `.env` :
```env
API_PORT=3001
```

Puis :
```bash
npm run api
```

### API : `pdf-parse` import error en ESM

Le module est CommonJS, l'import via `createRequire` est nécessaire (déjà géré dans `src/lib/pdf-parser.ts`). Si tu touches ce fichier, vérifier que le pattern :
```ts
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");
```
est conservé.

### Permissions / chemin Docker volume

Si `db:up` échoue avec une erreur sur `./db/data` :
```bash
sudo chown -R $(whoami) db/data/
# Ou supprimer pour forcer la recréation :
rm -rf db/data && npm run db:up && npm run db:migrate && npm run db:seed
```

## Mise à jour vers une nouvelle version

```bash
git pull origin master
npm install              # nouvelles dépendances éventuelles
npm run db:migrate       # nouvelles migrations
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
```

Les migrations 0001-0017 sont idempotentes. Les ETLs sont idempotents — tu peux relancer après chaque mise à jour sans craindre de doublons.

## Mise en place pour développement actif

Si tu souhaites contribuer / développer :

```bash
# Mode watch tests
npm run test:watch

# Connexion à la DB
npm run db:psql

# Logs Postgres
docker logs -f ffhandball-postgres

# Stop / restart proprement
npm run db:down
npm run db:up
```

## Pour aller plus loin

- **Architecture** : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`
- **Runbook opérationnel** : `docs/runbook.md` (toutes les commandes par entité)
- **Déploiement en production** : `docs/DEPLOY.md`
