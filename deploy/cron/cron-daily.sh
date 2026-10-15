#!/usr/bin/env bash
# deploy/cron/cron-daily.sh
# Scrape quotidien : structure des compétitions (poules, équipes, engagements) + matchs (journée courante)
# + classements & FdM des matchs joués récents
# (l'ETL FdM dérive le score sans attendre la publication serveur) + stats-joueurs.
# Lancé chaque nuit à 02:00 par le crontab utilisateur.

set -euo pipefail

# Une seule instance à la fois (évite les scrapes parallèles qui font bloquer le site).
exec 9>/tmp/ffhandball-cron-daily.lock
flock -n 9 || { echo "cron-daily déjà en cours, abandon."; exit 0; }

APP_DIR="${APP_DIR:-/opt/ffhandball}"
source "$(dirname "$0")/lib-saison.sh"
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

source "$(dirname "$0")/lib-notify.sh"
cd "$APP_DIR"

# Verrou global des scrapes : un seul scrape à la fois, tous crons confondus (cf. lib-lock.sh).
source "$(dirname "$0")/lib-lock.sh"
require_scrape_lock "cron-daily" 6 fail

# Suivi du cron en base (tableau de bord admin) — jamais bloquant.
source "$(dirname "$0")/lib-cron.sh"
cron_track_start "cron-daily" 16

log "=== Démarrage cron-daily (saison $SAISON) ==="

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

# 0. Structure des compétitions : les coupes, les phases suivantes et les tirages sont publiés EN COURS DE
#    SEMAINE. Avec un refresh hebdomadaire seulement, les engagements d'une coupe jouée le week-end manquaient
#    jusqu'au dimanche. En tête de cron pour que les nouvelles poules aient leurs matchs scrapés la même nuit.
#    Coût : ~12 min (≈1 300 pages), idempotent.
run_step "scrape competitions (poules, équipes, engagements)"   pnpm scrape --entity=competitions --saison="$SAISON"

run_step "etl competitions"   pnpm etl --entity=competitions --saison="$SAISON"

run_step "etl phases"   pnpm etl --entity=phases --saison="$SAISON"

run_step "etl poules"   pnpm etl --entity=poules --saison="$SAISON"

run_step "etl equipes"   pnpm etl --entity=equipes --saison="$SAISON"

run_step "etl engagements"   pnpm etl --entity=engagements --saison="$SAISON"

# 1. Matchs : journée courante + journées passées absentes de la base (ou restées « à jouer »). Sans
#    cela, une journée jouée n'est capturée que si le scrape passe pendant qu'elle est affichée par défaut.
run_step "scrape matchs (courante + passées manquantes)" \
  pnpm scrape --entity=matchs --saison="$SAISON" --journees=manquantes

run_step "etl matchs (incrémental)" \
  pnpm etl --entity=matchs --saison="$SAISON" --incremental

run_step "etl arbitres" \
  pnpm etl --entity=arbitres --saison="$SAISON"

run_step "etl match_officiels" \
  pnpm etl --entity=match_officiels --saison="$SAISON"

# 2. Classements (seulement les poules ayant joué récemment)
run_step "scrape classements (3 derniers jours)" \
  pnpm scrape --entity=classements --saison="$SAISON" --days=3

run_step "etl classements" \
  pnpm etl --entity=classements --saison="$SAISON"

# 3. Feuilles de match récentes : l'ETL en dérive le SCORE sans attendre la publication
#    serveur (le lendemain). Le scrape FdM ne cible que les matchs joués (date < auj.) ;
#    --days=10 le borne aux 10 derniers jours, et il saute les FdM déjà capturées → coût minime.
run_step "scrape feuilles-match (joués, 10 derniers jours)" \
  pnpm scrape --entity=feuilles-match --saison="$SAISON" --days=10

run_step "etl feuilles-match" \
  pnpm etl --entity=feuilles-match --saison="$SAISON"

# 4. Stats joueurs (national + régional séniors)
run_step "scrape stats-joueurs" \
  pnpm scrape --entity=stats-joueurs --saison="$SAISON"

run_step "etl stats-joueurs" \
  pnpm etl --entity=stats-joueurs --saison="$SAISON"

# ─── Bilan ───────────────────────────────────────────────────────────────────

if [ "$ERRORS" -eq 0 ]; then
  log "=== cron-daily terminé avec succès ==="
else
  log_err "=== cron-daily terminé avec $ERRORS erreur(s) — voir $LOG ==="
  notify_failure "cron-daily" "$ERRORS" "$LOG"
  exit 1
fi
