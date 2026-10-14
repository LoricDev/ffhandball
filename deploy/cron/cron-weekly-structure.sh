#!/usr/bin/env bash
# deploy/cron/cron-weekly-structure.sh
# Refresh structurel hebdomadaire : clubs / compétitions / phases / poules / équipes / engagements.
# Ces référentiels ne sont scrapés qu'au bootstrap mais dérivent en cours de saison (nouvelles
# équipes, poules de phase finale, renommages). Lancé chaque dimanche à 05:00.

set -euo pipefail

# Une seule instance à la fois (évite les scrapes parallèles qui font bloquer le site).
exec 9>/tmp/ffhandball-cron-weekly-structure.lock
flock -n 9 || { echo "cron-weekly-structure déjà en cours, abandon."; exit 0; }

APP_DIR="${APP_DIR:-/opt/ffhandball}"
source "$(dirname "$0")/lib-saison.sh"
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

source "$(dirname "$0")/lib-notify.sh"
cd "$APP_DIR"

# Verrou global des scrapes : un seul scrape à la fois, tous crons confondus (cf. lib-lock.sh).
source "$(dirname "$0")/lib-lock.sh"
require_scrape_lock "cron-weekly-structure" 8 fail

# Suivi du cron en base (tableau de bord admin) — jamais bloquant.
source "$(dirname "$0")/lib-cron.sh"
cron_track_start "cron-weekly-structure" 10

log "=== Démarrage cron-weekly-structure (saison $SAISON) ==="

ERRORS=0
run_step() {
  local label="$1"; shift
  log ">>> $label..."
  cron_track_step "$label"
  if "$@" >> "$LOG" 2>&1; then
    log "    $label : OK"
  else
    log_err "    $label : ECHEC (code $?)"
    ERRORS=$((ERRORS + 1))
    cron_track_error
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
  notify_failure "cron-weekly-structure" "$ERRORS" "$LOG"
  exit 1
fi
