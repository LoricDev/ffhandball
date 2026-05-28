#!/usr/bin/env bash
# deploy/cron/cron-daily.sh
# Scrape quotidien : journée courante matchs + ETL cascade + classements + stats-joueurs
# Lancé chaque nuit à 02:00 par le crontab utilisateur.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"
SAISON="${SAISON:-2025-2026}"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-daily-$DATE_NOW.log"

mkdir -p "$LOG_DIR"

# Charger nvm + Node 20 (cron n'a pas le PATH normal)
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

cd "$APP_DIR"

log "=== Démarrage cron-daily (saison $SAISON) ==="

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

# 1. Matchs journée courante
run_step "scrape matchs (journée courante)" \
  npm run scrape -- --entity=matchs --saison="$SAISON"

run_step "etl matchs" \
  npm run etl -- --entity=matchs --saison="$SAISON"

run_step "etl arbitres" \
  npm run etl -- --entity=arbitres --saison="$SAISON"

run_step "etl match_officiels" \
  npm run etl -- --entity=match_officiels --saison="$SAISON"

# 2. Classements
run_step "scrape classements" \
  npm run scrape -- --entity=classements --saison="$SAISON"

run_step "etl classements" \
  npm run etl -- --entity=classements --saison="$SAISON"

# 3. Stats joueurs (national + régional séniors)
run_step "scrape stats-joueurs" \
  npm run scrape -- --entity=stats-joueurs --saison="$SAISON"

run_step "etl stats-joueurs" \
  npm run etl -- --entity=stats-joueurs --saison="$SAISON"

# ─── Bilan ───────────────────────────────────────────────────────────────────

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-daily terminé avec succès ==="
else
  log_err "=== cron-daily terminé avec $ERRORS erreur(s) — voir $LOG ==="
  exit 1
fi
