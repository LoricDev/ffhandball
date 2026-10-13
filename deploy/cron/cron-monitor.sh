#!/usr/bin/env bash
# deploy/cron/cron-monitor.sh
# Récap quotidien : un mail par jour (santé des runs scrape/ETL, activité 24 h, qualité, alertes).
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
# pnpm monitor --digest : saison la plus récente par défaut ; envoie TOUJOURS le mail (alerte ou OK).
if pnpm monitor --digest >> "$LOG" 2>&1; then
  log "=== cron-monitor terminé ==="
else
  log "=== cron-monitor : le monitoring a échoué (voir $LOG) ==="
  # Le monitoring lui-même est tombé (ex. base injoignable) : notifier directement.
  pnpm notify "[ffhandball] ⚠️ Monitoring en échec" "Le monitoring quotidien n'a pas pu s'exécuter (voir $LOG sur le serveur)." >> "$LOG" 2>&1 || true
  exit 1
fi
