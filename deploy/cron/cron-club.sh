#!/usr/bin/env bash
# deploy/cron/cron-club.sh
# Mise à jour rapide pour UN club (ententes comprises) : matchs à chaque passage, classements + feuilles de match
# une fois par heure. Ne scrape que les poules du club (--club) : ~1-2 min au lieu des heures du cron-daily.
# Club : CLUB_CODE (code FFHB 7 chiffres ou id_ffhb), 5657013 (Bouzonville) par défaut.
# Lancé en week-end toutes les 15 min et en semaine matin/soir par le crontab utilisateur.
# Les ETL classements / feuilles-match sont limités au club (--club) ; l'ETL matchs reste global mais incrémental (quelques secondes).

set -euo pipefail

# Une seule instance à la fois.
exec 9>/tmp/ffhandball-cron-club.lock
flock -n 9 || { echo "cron-club déjà en cours, abandon."; exit 0; }

APP_DIR="${APP_DIR:-/opt/ffhandball}"
CLUB_CODE="${CLUB_CODE:-5657013}"
source "$(dirname "$0")/lib-saison.sh"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/cron-club-$DATE_NOW.log"

mkdir -p "$LOG_DIR"

# Charger nvm + Node 20 (cron n'a pas le PATH normal)
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

cd "$APP_DIR"

# Verrou global des scrapes : on passe notre tour s'il est pris (job idempotent, repris au prochain passage).
source "$(dirname "$0")/lib-lock.sh"
require_scrape_lock "cron-club" 0 skip

# Suivi du cron en base (tableau de bord admin) — jamais bloquant.
source "$(dirname "$0")/lib-cron.sh"
HOURLY=0
if [ "$((10#$(date +%M)))" -lt 15 ]; then HOURLY=1; fi
if [ "$HOURLY" -eq 1 ]; then cron_track_start "cron-club" 6; else cron_track_start "cron-club" 2; fi

log "=== Démarrage cron-club (club $CLUB_CODE, saison $SAISON, horaire=$HOURLY) ==="

ERRORS=0

run_step() {
  local label="$1"
  shift
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

run_step "scrape matchs club (courante + passées manquantes)" \
  pnpm scrape --entity=matchs --saison="$SAISON" --club="$CLUB_CODE" --journees=manquantes

run_step "etl matchs (incrémental)" \
  pnpm etl --entity=matchs --saison="$SAISON" --incremental

if [ "$HOURLY" -eq 1 ]; then
  run_step "scrape classements club (3 derniers jours)" \
    pnpm scrape --entity=classements --saison="$SAISON" --club="$CLUB_CODE" --days=3

  run_step "etl classements" \
    pnpm etl --entity=classements --saison="$SAISON" --club="$CLUB_CODE"

  run_step "scrape feuilles-match club (10 derniers jours)" \
    pnpm scrape --entity=feuilles-match --saison="$SAISON" --club="$CLUB_CODE" --days=10

  run_step "etl feuilles-match" \
    pnpm etl --entity=feuilles-match --saison="$SAISON" --club="$CLUB_CODE"
fi

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-club terminé avec succès ==="
else
  # Pas de mail ici (passages fréquents) : l'échec est visible dans le log et le tableau de bord admin.
  log_err "=== cron-club terminé avec $ERRORS erreur(s) — voir $LOG ==="
  exit 1
fi
