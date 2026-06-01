#!/usr/bin/env bash
# deploy/cron/cron-monthly-fdm-full.sh
# Rattrapage mensuel complet des feuilles de match (LONG : 30-100h multi-nuits)
# Lancé le 1er du mois à 22:00 par le crontab utilisateur.
# ATTENTION : peut s'étaler sur plusieurs nuits. Prévu pour être relancé (idempotent).

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"
SAISON="${SAISON:-2025-2026}"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-monthly-fdm-full-$DATE_NOW.log"

mkdir -p "$LOG_DIR"

# Charger nvm + Node 20
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

cd "$APP_DIR"

log "=== Démarrage cron-monthly-fdm-full (saison $SAISON) ==="
log "    Ce script peut durer 30-100h selon la volumétrie des FdM."

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

# Scrape FdM complet (sans --limit — scrape toutes les FdM non encore en raw)
# Le scraper est idempotent : saute les FdM déjà présentes en raw via natural_key
run_step "scrape feuilles-match (complet, sans limit)" \
  pnpm scrape --entity=feuilles-match --saison="$SAISON"

# ETL cascade : joueurs + match_compositions + match_actions + match_officiels arbitres
run_step "etl feuilles-match (cascade)" \
  pnpm etl --entity=feuilles-match --saison="$SAISON"

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-monthly-fdm-full terminé avec succès ==="
else
  log_err "=== cron-monthly-fdm-full terminé avec $ERRORS erreur(s) — voir $LOG ==="
  exit 1
fi
