#!/usr/bin/env bash
# deploy/cron/cron-weekly-structure.sh
# Refresh structurel hebdomadaire : clubs / compétitions / phases / poules / équipes / engagements.
# Ces référentiels ne sont scrapés qu'au bootstrap mais dérivent en cours de saison (nouvelles
# équipes, poules de phase finale, renommages). Lancé chaque dimanche à 05:00.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"
SAISON="${SAISON:-2025-2026}"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-weekly-structure-$DATE_NOW.log"

mkdir -p "$LOG_DIR"

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

cd "$APP_DIR"

log "=== Démarrage cron-weekly-structure (saison $SAISON) ==="

ERRORS=0
run_step() {
  local label="$1"; shift
  log ">>> $label..."
  if "$@" >> "$LOG" 2>&1; then
    log "    $label : OK"
  else
    log_err "    $label : ECHEC (code $?)"
    ERRORS=$((ERRORS + 1))
  fi
}

# Clubs & salles
run_step "scrape clubs"        pnpm scrape --entity=clubs        --saison="$SAISON"
run_step "scrape club-details" pnpm scrape --entity=club-details --saison="$SAISON"
run_step "etl salles"          pnpm etl    --entity=salles       --saison="$SAISON"
run_step "etl clubs"           pnpm etl    --entity=clubs        --saison="$SAISON"

# Compétitions / phases / poules / équipes / engagements
run_step "scrape competitions" pnpm scrape --entity=competitions --saison="$SAISON"
run_step "etl competitions"    pnpm etl    --entity=competitions --saison="$SAISON"
run_step "etl phases"          pnpm etl    --entity=phases       --saison="$SAISON"
run_step "etl poules"          pnpm etl    --entity=poules       --saison="$SAISON"
run_step "etl equipes"         pnpm etl    --entity=equipes      --saison="$SAISON"
run_step "etl engagements"     pnpm etl    --entity=engagements  --saison="$SAISON"

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-weekly-structure terminé avec succès ==="
else
  log_err "=== cron-weekly-structure terminé avec $ERRORS erreur(s) — voir $LOG ==="
  exit 1
fi
