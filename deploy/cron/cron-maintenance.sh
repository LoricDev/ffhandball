#!/usr/bin/env bash
# deploy/cron/cron-maintenance.sh
# Entretien hebdomadaire : purge des logs API (>90j) + VACUUM ANALYZE + rotation des logs cron.
# Lancé chaque dimanche à 06:00.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-maintenance-$DATE_NOW.log"

mkdir -p "$LOG_DIR"

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

cd "$APP_DIR"

log "=== Démarrage cron-maintenance ==="

ERRORS=0

# 1. Purge api_logs (>90j) + VACUUM ANALYZE
if pnpm maintenance >> "$LOG" 2>&1; then
  log "    maintenance DB : OK"
else
  log_err "    maintenance DB : ECHEC"
  ERRORS=$((ERRORS + 1))
fi

# 2. Rotation : supprimer les logs cron de plus de 30 jours
DELETED=$(find "$LOG_DIR" -name "cron-*.log" -mtime +30 -print -delete 2>/dev/null | wc -l | tr -d ' ')
log "    rotation logs : $DELETED fichier(s) >30j supprimé(s)"

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-maintenance terminé avec succès ==="
else
  log_err "=== cron-maintenance terminé avec $ERRORS erreur(s) — voir $LOG ==="
  exit 1
fi
