#!/usr/bin/env bash
# deploy/cron/cron-healthcheck.sh
# Sonde l'API toutes les 5 min (endpoint /ready). Alerte par mail UNE SEULE FOIS par incident
# (flag), et notifie le rétablissement. Lancé via cron */5.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-3000}"
URL="http://${API_HOST}:${API_PORT}/ready"
FLAG="${HEALTHCHECK_FLAG:-/tmp/ffhb-api-down.flag}"
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-healthcheck.log"
mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Charger nvm uniquement si on a besoin de pnpm (envoi de mail = changement d'état, rare).
notify() {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm use 20 > /dev/null 2>&1 || true
  (cd "$APP_DIR" && pnpm notify "$1" "$2" >> "$LOG" 2>&1) || true
}

if curl -fsS -m 5 "$URL" > /dev/null 2>&1; then
  # API OK — si elle était down, notifier le rétablissement.
  if [ -f "$FLAG" ]; then
    log "API rétablie ($URL)"
    notify "[ffhandball] ✅ API rétablie" "L'API répond de nouveau sur $URL."
    rm -f "$FLAG"
  fi
else
  # API KO — alerter une seule fois (tant que le flag n'existe pas).
  if [ ! -f "$FLAG" ]; then
    log "API injoignable ($URL) — alerte envoyée"
    notify "[ffhandball] ❌ API injoignable" "L'API ne répond plus sur $URL (sonde /ready)."
    : > "$FLAG"
  fi
fi
