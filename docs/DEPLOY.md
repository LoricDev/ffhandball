# Déploiement en production

## Déploiement express (recommandé)

Pour un déploiement clé-en-main, voir [`deploy/README.md`](../deploy/README.md) : 1 commande sur un VPS frais.

```bash
sudo ./deploy/deploy-all.sh
```

Le reste de ce document détaille les étapes manuelles si tu veux comprendre ou personnaliser chaque phase.

---

Guide pour déployer le pipeline ffhandball sur un serveur de production (VM Linux, VPS, ou serveur dédié) avec des scrapes nocturnes automatisés.

## Architecture cible

```
┌──────────────────────────────────────────────────┐
│  Serveur Linux (Ubuntu 22.04+ / Debian 12+)      │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │  Docker Compose                            │ │
│  │  ┌──────────────┐  ┌──────────────┐       │ │
│  │  │ PostgreSQL   │  │ Adminer (UI) │       │ │
│  │  │  port 5432   │  │  port 8081   │       │ │
│  │  └──────────────┘  └──────────────┘       │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │  Node.js 20+ (tsx)                         │ │
│  │  - cron : scrapes nocturnes                │ │
│  │  - logs : journald / fichiers              │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │  Backup quotidien Postgres → S3/local      │ │
│  └────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

## Pré-requis serveur

- Ubuntu 22.04+ ou Debian 12+ (autres distros possibles, adaptations mineures)
- 2 GB RAM minimum (4 GB recommandé pour --journees=all matchs)
- 20 GB disque (volumes Postgres + raw JSONB peuvent grossir)
- Connexion réseau outbound HTTP (ffhandball.fr accessible)
- Accès SSH

## Installation initiale

### 1. Système

```bash
# Mettre à jour le système
sudo apt update && sudo apt upgrade -y

# Outils de base
sudo apt install -y curl git build-essential

# Docker + Docker Compose
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Se déconnecter / reconnecter pour que le groupe prenne effet
```

### 2. Node.js 20 (via nvm — recommandé)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node --version  # v20.x
```

### 3. Cloner le repo

```bash
sudo mkdir -p /opt/ffhandball
sudo chown $USER:$USER /opt/ffhandball
git clone https://github.com/LoricDev/ffhandball.git /opt/ffhandball
cd /opt/ffhandball
```

### 4. Configuration

```bash
cp .env.example .env
nano .env
```

Adapter les variables :

```env
# DB — laisse en local sauf si Postgres managé externe
DATABASE_URL=postgresql://ffhandball:CHANGE_ME@localhost:5432/ffhandball

# IMPORTANT : User-Agent identifiable avec contact réel
SCRAPE_USER_AGENT="ffhandball-data-bot/1.0 (contact: admin@ton-domaine.fr)"

# Production : rate-limit plus généreux (anti-bannissement)
SCRAPE_RATE_LIMIT_MS=2000

# Pas plus de 1 en prod (politesse)
SCRAPE_CONCURRENCY=1

SCRAPE_RETRY_MAX=3
LOG_LEVEL=info
NODE_ENV=production
```

🔒 **Changer le mot de passe Postgres** dans `docker-compose.yml` :

```yaml
environment:
  POSTGRES_USER: ffhandball
  POSTGRES_PASSWORD: CHANGE_ME_STRONG_PASSWORD   # 20+ caractères aléatoires
```

Et mettre à jour `DATABASE_URL` en cohérence.

🔒 **Restreindre l'accès Adminer en production** : commenter le service `adminer` dans `docker-compose.yml`, ou le binder uniquement sur 127.0.0.1 :

```yaml
adminer:
  ports:
    - "127.0.0.1:8081:8080"   # uniquement local, accessible via SSH tunnel
```

### 5. Démarrage initial

```bash
pnpm install --prod --frozen-lockfile    # production : pas de devDependencies
pnpm db:up
sleep 10                   # attendre Postgres healthy
pnpm db:migrate
pnpm db:seed
```

### 6. Premier scrape complet

```bash
# Phase 1 : entités structurelles (~30 min)
pnpm scrape --entity=clubs --saison=2025-2026 --url=https://www.ffhandball.fr/clubs
pnpm etl --entity=clubs --saison=2025-2026

pnpm scrape --entity=club-details --saison=2025-2026
pnpm etl --entity=salles --saison=2025-2026
pnpm etl --entity=clubs  --saison=2025-2026   # re-run pour résoudre salle_principale_id

# Phase 2 : compétitions/équipes (~60 min)
pnpm scrape --entity=competitions --saison=2025-2026
pnpm etl --entity=competitions --saison=2025-2026
pnpm etl --entity=phases       --saison=2025-2026
pnpm etl --entity=poules       --saison=2025-2026
pnpm etl --entity=equipes      --saison=2025-2026
pnpm etl --entity=engagements  --saison=2025-2026

# Phase 3 : matchs (--journees=all = 17-33h, à lancer en plusieurs nuits)
pnpm scrape --entity=matchs --saison=2025-2026 --journees=all
pnpm etl --entity=matchs           --saison=2025-2026
pnpm etl --entity=arbitres         --saison=2025-2026
pnpm etl --entity=match_officiels  --saison=2025-2026

# Phase 4 — Feuilles de match PDFs (MULTI-NUITS : ~30-100h selon scope)

# Re-scrape matchs pour récupérer fdm_code dans core.matchs (~1h)
pnpm scrape --entity=matchs --saison=2025-2026
pnpm etl --entity=matchs --saison=2025-2026

# Scrape FdM (long, prévoir cron nocturne sur plusieurs jours)
pnpm scrape --entity=feuilles-match --saison=2025-2026

# ETL cascade (joueurs + compositions + match_actions + match_officiels arbitres)
pnpm etl --entity=feuilles-match --saison=2025-2026
```

## API HTTP en production

Après le scrape initial, démarrer l'API HTTP publique :

### Démarrage manuel (test)

```bash
cd /opt/ffhandball
pnpm api &
curl http://localhost:3000/health
```

### Daemon via systemd (recommandé)

Créer `/etc/systemd/system/ffhandball-api.service` :

```ini
[Unit]
Description=ffhandball API HTTP
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/ffhandball
ExecStart=/home/ubuntu/.nvm/versions/node/v20.18.0/bin/node --env-file=.env --import tsx src/api/server.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Activer :

```bash
sudo systemctl daemon-reload
sudo systemctl enable ffhandball-api
sudo systemctl start ffhandball-api
sudo systemctl status ffhandball-api
journalctl -u ffhandball-api -f
```

### Reverse proxy nginx (production publique)

L'API écoute sur 127.0.0.1:3000 (cf. `API_HOST=127.0.0.1` dans `.env`). Exposer via nginx avec HTTPS :

```nginx
server {
    listen 443 ssl http2;
    server_name api.ton-domaine.fr;

    ssl_certificate /etc/letsencrypt/live/api.ton-domaine.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.ton-domaine.fr/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Rate-limit nginx en complément (protection L7)
    limit_req zone=api burst=20 nodelay;
}

# Dans le bloc http {} :
limit_req_zone $binary_remote_addr zone=api:10m rate=120r/m;
```

⚠️ **`X-Forwarded-For` essentiel** : le rate-limit Hono lit cette en-tête pour distinguer les IPs derrière le proxy. Sans ça, tout le monde apparaît comme `127.0.0.1` et un seul bucket rate-limit.

### Configuration .env production API

```env
API_PORT=3000
API_HOST=127.0.0.1                # binding local (nginx fait le proxy)
API_RATE_LIMIT_PER_MIN=120        # plus généreux qu'en dev
API_PAGINATION_DEFAULT_LIMIT=20
API_PAGINATION_MAX_LIMIT=100
```

### Smoke test post-déploiement

```bash
curl -s https://api.ton-domaine.fr/health | jq
curl -s "https://api.ton-domaine.fr/clubs?q=brest&limit=3" | jq
open https://api.ton-domaine.fr/docs
```

## Cron : scrape quotidien automatisé

### Stratégie recommandée

| Fréquence | Tâche | Coût HTTP | Durée |
|---|---|---|---|
| **Quotidien (nuit)** | Scrape journée courante matchs + ETLs | ~1500-3000 req | ~1h |
| **Hebdomadaire** | Re-scrape club-details (nouveaux clubs) + competitions structurelles | ~3000 req | ~30 min |
| **Hebdomadaire (nuit)** | Scrape FdM pour matchs récemment joués (filtre date_from = J-7) | ~1-3k req | ~1h |
| **Mensuel** | `--journees=all` matchs (rattrapage historique complet) | ~40-80k req | 17-33h (multi-nuits) |
| **Mensuel (multi-nuits)** | Scrape FdM complet pour rattrapage historique | ~50-200k req | 30-100h |

### Setup cron

Les scripts sont versionnés dans `deploy/cron/` et installés d'un coup :

```bash
bash deploy/cron/install-crontab.sh
crontab -l      # vérifier
```

| Fréquence | Script | Rôle |
|---|---|---|
| Quotidien 02:00 | `cron-daily.sh` | Matchs (journée courante), ETL, classements, FdM des 10 derniers jours, stats joueurs |
| Quotidien 07:00 | `cron-monitor.sh` | **Récap quotidien par mail** (voir « Mails et alertes ») |
| Toutes les 5 min | `cron-healthcheck.sh` | Sonde l'API (`/ready`) et le disque (seuil 85 %), un mail par incident et au rétablissement |
| Lundi 03:00 | `cron-weekly-fdm-recent.sh` | FdM des 30 derniers jours + ETL |
| Dimanche 05:00 | `cron-weekly-structure.sh` | Clubs, détails, salles, compétitions, poules, équipes |
| Dimanche 06:00 | `cron-maintenance.sh` | Purge `api_logs` / `etl_warnings`, VACUUM, rotation des logs |
| Jours 1 à 5 du mois, 22:00 | `cron-monthly-fdm-full.sh` | Rattrapage FdM complet (30-100 h au total), **budget 4 h par nuit** puis reprise (idempotent) |
| Chaque minute | `webhooks-deliver.sh` | Envoie les webhooks de résultats dus (voir `docs/webhooks.md`) ; sort aussitôt s'il n'y en a pas |
| Le 9 du mois 08:00 | `test-restore.sh` | Restaure le dernier backup dans une base temporaire, compare les volumes, supprime la base (mail si échec) |
| Quotidien 04:30 | `backup-daily.sh` | Sauvegarde `core.*` **vérifiée** (gzip -t + taille mini, mail si invalide), rotation 14 jours |

Points à connaître :

- **Saison automatique** : `lib-saison.sh` bascule le 1er juillet (avant le correctif d'octobre 2026, les crons restaient codés sur la saison précédente). Surcharge possible : `SAISON=2026-2027 bash deploy/cron/cron-daily.sh`.
- **Un seul exemplaire à la fois** : chaque script prend un verrou `flock` (même script deux fois).
- **Un seul scrape à la fois, tous crons confondus** : `lib-lock.sh` ajoute un verrou global (`/tmp/ffhandball-scrape.lock`). Les crons s'attendent au lieu de se chevaucher (la source bride l'IP sinon) : le quotidien attend jusqu'à 6 h, les hebdos 8 h (mail si le verrou n'est jamais obtenu), le mensuel passe son tour s'il est occupé.
- **Échec = mail immédiat** : si une étape échoue, le script envoie un mail (`lib-notify.sh`) en plus de l'écrire dans son log.
- **Lancer un cron à la main** : `bash deploy/cron/cron-monitor.sh` (le log est dans `/var/log/ffhandball/`).

#### Rattrapage manuel des FdM

Le serveur de FdM (`fdm.fdme.ffhandball.fr`, derrière CloudFront) répond `429` quand le débit est trop élevé : le scrape se met alors en pause (60 s, 120 s…) et reprend seul. Rien n'est mémorisé sur un blocage, donc la commande est relançable à volonté. Pour rattraper une période en tâche de fond :

```bash
cd /opt/ffhandball
SCRAPE_FDM_RATE_LIMIT_MS=4000 nohup bash -c \
  'pnpm scrape --entity=feuilles-match --saison=2026-2027 --days=60 && pnpm etl --entity=feuilles-match --saison=2026-2027' \
  > /tmp/fdm-rattrapage.log 2>&1 &

grep "scrape feuilles-match:" /tmp/fdm-rattrapage.log | tail -1   # progression
```

Compter ~3-5 PDF par minute en pratique (la progression affichée « ETA » est faussée par les pauses). Les scores sont appliqués par l'ETL `feuilles-match` ; un match perdu par forfait n'a pas de FdM (404), c'est normal.

### Logs

Le cron écrit dans `/var/log/ffhandball/cron-daily-YYYY-MM-DD.log`. Rotation logs :

```bash
sudo nano /etc/logrotate.d/ffhandball
```

```
/var/log/ffhandball/*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
}
```

## Monitoring

### Suivi de l'activité

Requêtes SQL utiles à exécuter régulièrement (via Adminer ou `pnpm db:psql`) :

```sql
-- Derniers scrape_runs (5 derniers)
SELECT scraper_name, status, pages_scraped, started_at, finished_at,
       finished_at - started_at AS duration
  FROM raw.scrape_runs
  ORDER BY started_at DESC LIMIT 5;

-- Derniers ETLs (10 derniers)
SELECT entity, status, rows_inserted, rows_updated, warnings_count, finished_at
  FROM core.etl_runs
  ORDER BY started_at DESC LIMIT 10;

-- État du pipeline (totaux par table)
SELECT 'clubs' AS t, count(*) FROM core.clubs
UNION ALL SELECT 'salles', count(*) FROM core.salles
UNION ALL SELECT 'competitions', count(*) FROM core.competitions
UNION ALL SELECT 'phases', count(*) FROM core.phases
UNION ALL SELECT 'poules', count(*) FROM core.poules
UNION ALL SELECT 'equipes', count(*) FROM core.equipes
UNION ALL SELECT 'engagements', count(*) FROM core.engagements
UNION ALL SELECT 'matchs', count(*) FROM core.matchs
UNION ALL SELECT 'arbitres', count(*) FROM core.arbitres
UNION ALL SELECT 'match_officiels', count(*) FROM core.match_officiels;

-- Warnings récents (24h)
SELECT entity, message, count(*) FROM core.etl_warnings
  WHERE etl_run_id IN (SELECT id FROM core.etl_runs WHERE started_at > now() - interval '24 hours')
  GROUP BY entity, message ORDER BY count(*) DESC;
```

### Mails et alertes

Configuration SMTP dans `.env` (sans elle, aucun mail n'est envoyé, sans erreur) :

```env
MAIL_HOST=smtp.exemple.fr
MAIL_PORT=587            # 465 = TLS direct, sinon STARTTLS
MAIL_USER=...
MAIL_PASSWORD=...        # Gmail : « mot de passe d'application » (validation en 2 étapes requise)
MAIL_FROM="ffhandball <adresse@exemple.fr>"
MAIL_TO=destinataire@exemple.fr
```

`pnpm mail:test` vérifie la configuration et envoie un mail de test.

| Mail | Quand |
|---|---|
| **Récap quotidien** | Tous les jours à 07:00 (`pnpm monitor --digest`) : objet = problème principal ou « tout est OK » |
| **Cron en échec** | Immédiatement, quand une étape d'un cron échoue (`lib-notify.sh`) |
| **API injoignable / rétablie** | Une seule fois par incident (`cron-healthcheck.sh`) |
| **Pipeline terminé / échoué** | Fin de `pnpm pipeline` (durée totale, commande de relance exacte) |

Le récap (`pnpm monitor`) vérifie : runs en échec ou partiels, fraîcheur (36 h par défaut), saison traitée = saison courante, scrape `matchs`/`competitions` réussi mais à 0 page, et matchs joués depuis plus de 10 jours sans score. Il affiche aussi l'activité des dernières 24 h et la progression des runs en cours.

Pour les matchs sans score, le mail sépare :

- **À surveiller** (déclenche l'alerte) : cause probable par match (code FdM absent, 404, PDF illisible, hors fenêtre des crons, rattrapage en cours…), liens vers la poule et le PDF de la FdM, requête SQL de vérification, « nouveaux depuis hier ».
- **Bruit probable** (n'alerte pas) : tournois de détection (pas de FdM) et FdM en 404 depuis plus de `SCRAPE_FDM_MAX_AGE_DAYS` jours (forfait / non joué).

Options : `pnpm monitor --saison=2026-2027 --max-age-hours=36 --stale-score-days=10 --digest`. Sans `--digest`, le mail n'est envoyé que s'il y a un problème.

#### Entretien de la base

- `pnpm maintenance` (dimanche 06:00) purge les `api_logs` > 90 j et les `etl_warnings` des runs > 30 j, puis `VACUUM`. `--dry-run` pour voir sans supprimer. `VACUUM` rend l'espace réutilisable mais ne réduit pas les fichiers (`VACUUM FULL` verrouille la table).
- `pnpm prune-raw` limite la croissance du schéma `raw` (append-only). Par défaut c'est un **dry-run** ; il n'est volontairement pas planifié : choisis une rétention puis exécute par exemple `pnpm prune-raw --older-than-days=120` (puis `--apply`).
- Le conteneur Postgres a `shm_size: 256mb` (`docker-compose.yml`) : avec les 64 Mo par défaut de Docker, les `VACUUM` parallèles échouent (« No space left on device » sur un segment de mémoire partagée). Appliqué à la prochaine recréation : `docker compose up -d postgres`.

### Disk usage

`raw.matchs` peut grossir vite (chaque scrape ajoute des lignes, append-only). Surveiller :

```sql
SELECT
  schemaname || '.' || tablename AS table,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS size
FROM pg_tables
WHERE schemaname IN ('raw', 'core')
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
LIMIT 15;
```

Nettoyage des lignes raw obsolètes (garder seulement la dernière par natural_key) :

```sql
-- ATTENTION : irréversible. À faire après backup.
DELETE FROM raw.matchs r
  USING (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY natural_key ORDER BY scraped_at DESC) AS rn
      FROM raw.matchs
  ) AS dup
  WHERE r.id = dup.id AND dup.rn > 1;

VACUUM FULL raw.matchs;
```

## Backup

### Strategy

- **Quotidien** : dump de `core.*` — recover rapide (~50-500 MB, dépend du remplissage joueurs+match_actions)
- **Hebdomadaire** : dump de `raw.*` (gros volume JSONB) — pour replay éventuel
- **Mensuel** : dump complet + snapshot du `db/data/` (cold backup)

⚠️ **Volumétrie core après FdM** : `core.match_actions` peut atteindre 10-15M lignes (~1-2 GB) et `core.match_compositions` ~3M lignes (~500 MB). Le dump grossit significativement vs avant FdM. Considérer un dump séparé de ces 2 tables avec rotation plus longue, ou un dump compressé `pg_dump --compress=9`.

### Script de backup

```bash
#!/usr/bin/env bash
# /opt/ffhandball/scripts/backup-daily.sh
set -euo pipefail

BACKUP_DIR=/var/backups/ffhandball
DATE=$(date +%Y%m%d-%H%M)
mkdir -p "$BACKUP_DIR"

# Dump core uniquement (rapide, ~10-100 MB)
docker exec ffhandball-postgres pg_dump -U ffhandball -d ffhandball \
  --schema=core --no-owner --no-acl \
  | gzip > "$BACKUP_DIR/core-$DATE.sql.gz"

# Rotation : garder 14 jours
find "$BACKUP_DIR" -name "core-*.sql.gz" -mtime +14 -delete

# Optionnel : upload S3
# aws s3 cp "$BACKUP_DIR/core-$DATE.sql.gz" s3://my-bucket/ffhandball/
```

Crontab :

```cron
30 3 * * *  /opt/ffhandball/scripts/backup-daily.sh
```

### Restore

```bash
# Stopper les conteneurs
docker compose down

# Recréer la DB
docker compose up -d postgres
sleep 5

# L'extension pg_trgm doit exister AVANT la restauration (le dump ne contient que le schéma core,
# or des index utilisent gin_trgm_ops : sans elle la restauration échoue à cet index)
docker exec ffhandball-postgres psql -U ffhandball -d ffhandball -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"

# Restaurer
gunzip -c /var/backups/ffhandball/core-20260527-0330.sql.gz \
  | docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball
```

> ⚠️ Le backup quotidien ne couvre que le schéma `core.*`. Le schéma `raw.*` (captures brutes, ~6 Go) n'est **pas** sauvegardé : il se reconstitue en re-scrapant. `deploy/cron/test-restore.sh` (le 9 du mois) vérifie que le dernier backup se restaure réellement.

## Sécurité

### Firewall

Ne pas exposer Postgres (5432) ni Adminer (8081) sur Internet. Utiliser UFW :

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw enable
```

Pour accéder à Adminer depuis ton poste local : SSH tunnel :

```bash
ssh -L 8081:127.0.0.1:8081 user@serveur
# Puis ouvre http://localhost:8081 sur ton poste
```

### Secrets

Le fichier `.env` contient des secrets (DB password notamment). Vérifier :
- `.env` est dans `.gitignore` (déjà fait)
- Permissions : `chmod 600 .env`
- Sauvegarder le mot de passe DB dans un gestionnaire de mots de passe

### RGPD : données joueurs (FdM)

Les feuilles de match exposent publiquement nom, prénom, numéro de licence FFHB (incluant des mineurs en compétitions jeunes). Le pipeline les stocke en clair dans `core.joueurs`.

**Responsabilités côté hébergeur** :
- Notice d'information sur l'API publique mentionnant la source FFHB et le scope
- Mécanisme de droit à l'oubli (DELETE par numero_licence) si requête utilisateur
- Pas d'enrichissement par croisement avec données externes
- Logs API : ne PAS logger les `numero_licence` dans les URL (n'apparaissent que dans `path` qui est déjà loggé — accepter cette légère exposition vs masquer)

**Recommandation** : si l'API devient publique grand-public, faire valider la conformité par un juriste/DPO.

### Mises à jour

```bash
cd /opt/ffhandball
git pull origin master
pnpm install --prod --frozen-lockfile
pnpm db:migrate      # idempotent
# Pas besoin de re-scraper après MAJ (les ETLs idempotents peuvent rejouer)
```

Les migrations sont versionnées dans `db/migrations/`, idempotentes via `IF NOT EXISTS`.

## Disaster recovery

### Reset complet (perte de toutes les données)

```bash
docker compose down -v    # ⚠️ supprime le volume db/data
docker compose up -d
sleep 10
pnpm db:migrate
pnpm db:seed
# Puis re-lancer un scrape complet (~24h pour les 3 niveaux)
```

### Rejeu ETLs uniquement (raw conservé)

Si seul `core.*` est corrompu mais `raw.*` est OK :

```sql
TRUNCATE core.match_officiels;
TRUNCATE core.arbitres CASCADE;
TRUNCATE core.matchs CASCADE;
TRUNCATE core.engagements;
TRUNCATE core.equipes CASCADE;
TRUNCATE core.poules CASCADE;
TRUNCATE core.phases CASCADE;
TRUNCATE core.competitions CASCADE;
TRUNCATE core.salles CASCADE;
UPDATE core.clubs SET salle_principale_id = NULL;
```

Puis ré-exécuter tous les ETLs dans l'ordre du runbook. Aucun re-scrape nécessaire.

## Coûts estimés

| Resource | Quantité | Coût mensuel approximatif |
|---|---|---|
| VPS 2 vCPU / 4 GB / 40 GB | 1 | 6-12 € (Hetzner, OVH) |
| Bande passante outbound | ~5-10 GB/mois | inclus |
| Backup S3 (optionnel) | ~5 GB | < 1 € |

Le pipeline est volontairement frugal — pas besoin de Kubernetes ni de cloud premium.

## Pour aller plus loin

- **Runbook opérationnel** : `docs/runbook.md` (commandes exhaustives par entité)
- **Architecture** : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`
- **Installation locale** : `docs/INSTALL.md`
