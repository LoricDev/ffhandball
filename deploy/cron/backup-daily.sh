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
  | gzip > "$BACKUP_FILE" || DUMP_FAILED=1

# Vérification : un dump tronqué (disque plein, conteneur redémarré en cours de route…) est pire
# qu'un backup manquant. On contrôle l'intégrité gzip et une taille plancher (1 Mo).
MIN_BYTES="${BACKUP_MIN_BYTES:-1048576}"
if [ "${DUMP_FAILED:-0}" -eq 1 ] || ! gzip -t "$BACKUP_FILE" 2>/dev/null \
   || [ "$(stat -c %s "$BACKUP_FILE" 2>/dev/null || echo 0)" -lt "$MIN_BYTES" ]; then
  log_err "Backup invalide (pg_dump en échec, archive corrompue ou < ${MIN_BYTES} octets) — fichier supprimé."
  rm -f "$BACKUP_FILE"
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm use 20 > /dev/null 2>&1 || true
  (cd "${APP_DIR:-/opt/ffhandball}" && pnpm notify "[ffhandball] ❌ Backup quotidien invalide" \
    "Le dump core.* du $(date +%F) a échoué ou est invalide sur $(hostname 2>/dev/null || echo serveur). Les backups précédents sont conservés. Voir $LOG." \
    >> "$LOG" 2>&1) || true
  exit 1
fi

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
log "Backup créé et vérifié : $BACKUP_FILE ($BACKUP_SIZE)"

# Rotation : garder 14 jours
DELETED=$(find "$BACKUP_DIR" -name "core-*.sql.gz" -mtime +14 -print -delete | wc -l)
if [ "$DELETED" -gt 0 ]; then
  log "Rotation : $DELETED fichier(s) supprimé(s) (>14 jours)."
fi

log "=== backup-daily terminé ==="
