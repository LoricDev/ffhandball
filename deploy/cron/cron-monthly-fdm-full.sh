#!/usr/bin/env bash
# deploy/cron/cron-monthly-fdm-full.sh
# Rattrapage mensuel complet des feuilles de match (LONG : 30-100h au total)
# Lancé les nuits des jours 1 à 5 du mois à 22:00 par le crontab utilisateur, avec un budget de
# FDM_MONTHLY_BUDGET_H heures (défaut 4) par nuit : il rend le verrou global avant le cron-daily de
# 02:00 et reprend le lendemain (idempotent). S'il n'y a plus rien à rattraper, il se termine vite.

set -euo pipefail

# Une seule instance à la fois (évite les scrapes parallèles qui font bloquer le site).
exec 9>/tmp/ffhandball-cron-monthly-fdm-full.lock
flock -n 9 || { echo "cron-monthly-fdm-full déjà en cours, abandon."; exit 0; }

APP_DIR="${APP_DIR:-/opt/ffhandball}"
source "$(dirname "$0")/lib-saison.sh"
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

source "$(dirname "$0")/lib-notify.sh"
cd "$APP_DIR"

# Verrou global des scrapes : un seul scrape à la fois, tous crons confondus (cf. lib-lock.sh).
source "$(dirname "$0")/lib-lock.sh"
require_scrape_lock "cron-monthly-fdm-full" 2 skip

# Suivi du cron en base (tableau de bord admin) — jamais bloquant.
source "$(dirname "$0")/lib-cron.sh"
cron_track_start "cron-monthly-fdm-full" 2

log "=== Démarrage cron-monthly-fdm-full (saison $SAISON) ==="
log "    Rattrapage borné à ${FDM_MONTHLY_BUDGET_H:-4} h par nuit, relancé les nuits suivantes (idempotent)."

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

# Scrape FdM complet : tous les matchs JOUÉS de la saison jusqu'à aujourd'hui, pas encore
# capturés (les matchs à venir n'ont pas de FdM → exclus). Idempotent : saute les FdM déjà
# présentes en raw via natural_key.
# Budget de temps PAR NUIT : le rattrapage complet est très long (30-100 h la première fois). On le
# borne pour qu'il rende le verrou global avant le cron-daily de 02:00 ; il est relancé les nuits
# suivantes (crontab : jours 1 à 5) et reprend là où il s'est arrêté (idempotent).
BUDGET_H="${FDM_MONTHLY_BUDGET_H:-4}"
cron_track_step "scrape feuilles-match (complet, budget ${BUDGET_H} h)"
log ">>> scrape feuilles-match (complet, jusqu'à aujourd'hui) — budget ${BUDGET_H} h..."
set +e
timeout -k 120 "${BUDGET_H}h" pnpm scrape --entity=feuilles-match --saison="$SAISON" >> "$LOG" 2>&1
RC=$?
set -e
if [ "$RC" -eq 0 ]; then
  log "    scrape feuilles-match : TERMINÉ (rien de plus à rattraper)"
elif [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then
  log "    scrape feuilles-match : budget de ${BUDGET_H} h atteint — reprise automatique la nuit suivante"
else
  log_err "    scrape feuilles-match : ECHEC (code $RC)"
  ERRORS=$((ERRORS + 1))
  cron_track_error
fi

# ETL cascade : joueurs + match_compositions + match_actions + match_officiels arbitres
run_step "etl feuilles-match (cascade)" \
  pnpm etl --entity=feuilles-match --saison="$SAISON"

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-monthly-fdm-full terminé avec succès ==="
else
  log_err "=== cron-monthly-fdm-full terminé avec $ERRORS erreur(s) — voir $LOG ==="
  notify_failure "cron-monthly-fdm-full" "$ERRORS" "$LOG"
  exit 1
fi
