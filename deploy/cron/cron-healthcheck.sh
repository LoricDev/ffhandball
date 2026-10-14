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

# --- Espace disque : alerte UNE FOIS quand le disque dépasse le seuil (la base fait ~11 Go et
# grossit ; un disque plein casse les scrapes, les backups et Postgres). Rétablissement notifié.
DISK_FLAG="${DISK_FLAG:-/tmp/ffhb-disk-high.flag}"
DISK_MAX_PCT="${DISK_MAX_PCT:-85}"
DISK_PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9' || true)
if [ -n "$DISK_PCT" ]; then
  if [ "$DISK_PCT" -ge "$DISK_MAX_PCT" ]; then
    if [ ! -f "$DISK_FLAG" ]; then
      log "Disque à ${DISK_PCT} % (seuil ${DISK_MAX_PCT} %) — alerte envoyée"
      notify "[ffhandball] ⚠️ Disque à ${DISK_PCT} %" "Le disque racine est rempli à ${DISK_PCT} % (seuil ${DISK_MAX_PCT} %) sur $(hostname 2>/dev/null || echo serveur). Penser à purger (pnpm prune-raw, anciens backups) ou agrandir le volume."
      : > "$DISK_FLAG"
    fi
  elif [ -f "$DISK_FLAG" ] && [ "$DISK_PCT" -lt "$((DISK_MAX_PCT - 5))" ]; then
    log "Disque revenu à ${DISK_PCT} %"
    notify "[ffhandball] ✅ Espace disque rétabli" "Le disque racine est repassé à ${DISK_PCT} %."
    rm -f "$DISK_FLAG"
  fi
fi

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
