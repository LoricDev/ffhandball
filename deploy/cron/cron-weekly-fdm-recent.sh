#!/usr/bin/env bash
# deploy/cron/cron-weekly-fdm-recent.sh
# Rattrapage hebdomadaire des FdM des matchs joués des 30 derniers jours (filet pour les FdM
# publiées tardivement, au-delà de la fenêtre de 10 jours du cron-daily).
# Lancé chaque lundi à 03:00 par le crontab utilisateur.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"
SAISON="${SAISON:-2025-2026}"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-weekly-fdm-recent-$DATE_NOW.log"

mkdir -p "$LOG_DIR"

# Charger nvm + Node 20
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

cd "$APP_DIR"

log "=== Démarrage cron-weekly-fdm-recent (saison $SAISON) ==="

ERRORS=0

run_step() {
  local label="$1"
  shift
  log ">>> $label..."
  if "$@" >> "$LOG" 2>&1; then
    log "    $label : OK"
  else
    log_err "    $label : ECHEC (code $?)"
    ERRORS=$((ERRORS + 1))
  fi
}

# Rattrapage FdM des matchs joués des 30 derniers jours (filet plus large que le cron-daily,
# qui couvre déjà 10 jours). Le scrape FdM ne cible que les matchs joués (date < auj.) ;
# les FdM déjà capturées sont ignorées → ne télécharge que les FdM tardives nouvellement publiées.
run_step "scrape feuilles-match (joués, 30 derniers jours)" \
  pnpm scrape --entity=feuilles-match --saison="$SAISON" --days=30

run_step "etl feuilles-match" \
  pnpm etl --entity=feuilles-match --saison="$SAISON"

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-weekly-fdm-recent terminé avec succès ==="
else
  log_err "=== cron-weekly-fdm-recent terminé avec $ERRORS erreur(s) — voir $LOG ==="
  exit 1
fi
