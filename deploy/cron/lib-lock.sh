#!/usr/bin/env bash
# deploy/cron/lib-lock.sh — verrou GLOBAL des scrapes.
#
# La source (CloudFront → origine) bride l'IP dès que plusieurs scrapers tournent en parallèle
# (403/405/429, cooldowns de plusieurs minutes). Chaque cron a déjà son propre flock (même script
# deux fois), mais deux crons différents (daily + weekly + monthly…) pouvaient se chevaucher.
# Ce verrou partagé les fait passer UN PAR UN.
#
# À sourcer APRÈS la définition de log / log_err et lib-notify.sh, avec APP_DIR et LOG définis.
#
# Usage :
#   require_scrape_lock "<nom du cron>" <attente max en heures> [fail|skip]
#     fail (défaut) : verrou non obtenu → log + mail + exit 1
#     skip          : verrou non obtenu → log + exit 0 (job idempotent, repris à la prochaine échéance)
# Le verrou est conservé (fd 8) jusqu'à la fin du script, et hérité par les processus enfants :
# même si le script est tué, il n'est libéré qu'à la mort du dernier scrape qu'il a lancé.

SCRAPE_LOCK_FILE="${SCRAPE_LOCK_FILE:-/tmp/ffhandball-scrape.lock}"

require_scrape_lock() {
  local name="$1" wait_h="${2:-0}" mode="${3:-fail}"
  exec 8>"$SCRAPE_LOCK_FILE"

  if flock -n 8; then
    return 0
  fi

  if [ "$wait_h" -gt 0 ]; then
    log "Un autre scrape est en cours — $name attend le verrou global (max ${wait_h} h)..."
    if flock -w "$((wait_h * 3600))" 8; then
      log "Verrou global obtenu."
      return 0
    fi
  fi

  if [ "$mode" = "skip" ]; then
    log "Un autre scrape tient le verrou global — $name passe son tour (idempotent, repris à la prochaine échéance)."
    exit 0
  fi

  log_err "verrou global des scrapes non obtenu (attente ${wait_h} h) — $name abandonné"
  (cd "$APP_DIR" && pnpm notify "[ffhandball] ❌ ${name} non exécuté" \
    "${name} n'a pas pu démarrer : un autre scrape a gardé le verrou global pendant plus de ${wait_h} h sur $(hostname 2>/dev/null || echo serveur). Voir ${LOG}." \
    >> "$LOG" 2>&1) || true
  exit 1
}
