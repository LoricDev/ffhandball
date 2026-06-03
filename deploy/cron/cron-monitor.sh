#!/usr/bin/env bash
# deploy/cron/cron-monitor.sh
# Monitoring quotidien : santé des runs scrape/ETL + fraîcheur + qualité, alerte par mail.
# Lancé chaque matin à 07:00 (après le cron-daily de 02:00).

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-monitor-$DATE_NOW.log"

mkdir -p "$LOG_DIR"

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

cd "$APP_DIR"

log "=== Démarrage cron-monitor ==="
# pnpm monitor : saison la plus récente par défaut ; envoie un mail si problème détecté.
if pnpm monitor >> "$LOG" 2>&1; then
  log "=== cron-monitor terminé ==="
else
  log "=== cron-monitor : le monitoring a échoué (voir $LOG) ==="
  # Le monitoring lui-même est tombé (ex. base injoignable) : notifier directement.
  pnpm notify "[ffhandball] ⚠️ Monitoring en échec" "Le monitoring quotidien n'a pas pu s'exécuter (voir $LOG sur le serveur)." >> "$LOG" 2>&1 || true
  exit 1
fi
