#!/usr/bin/env bash
# deploy/cron/backup-daily.sh
# Dump quotidien de core.* avec rotation 14 jours.
# Lancé chaque nuit à 04:30 par le crontab utilisateur.

set -euo pipefail

BACKUP_DIR=/var/backups/ffhandball
LOG_DIR=/var/log/ffhandball
DATE=$(date +%Y%m%d-%H%M)
LOG="$LOG_DIR/backup.log"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

log "=== Démarrage backup-daily ==="

# Vérifier que le conteneur Postgres est up
if ! docker exec ffhandball-postgres pg_isready -U ffhandball -d ffhandball &>/dev/null; then
  log_err "Postgres non accessible — backup annulé."
  exit 1
fi

BACKUP_FILE="$BACKUP_DIR/core-$DATE.sql.gz"

# Dump core.* uniquement (rapide, ~50-500 MB compressé)
log "Dump core.* vers $BACKUP_FILE..."
docker exec ffhandball-postgres pg_dump \
  -U ffhandball \
  -d ffhandball \
  --schema=core \
  --no-owner \
  --no-acl \
  | gzip > "$BACKUP_FILE"

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
log "Backup créé : $BACKUP_FILE ($BACKUP_SIZE)"

# Rotation : garder 14 jours
DELETED=$(find "$BACKUP_DIR" -name "core-*.sql.gz" -mtime +14 -print -delete | wc -l)
if [ "$DELETED" -gt 0 ]; then
  log "Rotation : $DELETED fichier(s) supprimé(s) (>14 jours)."
fi

log "=== backup-daily terminé ==="
