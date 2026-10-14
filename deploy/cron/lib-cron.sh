#!/usr/bin/env bash
# deploy/cron/lib-cron.sh — suivi d'un cron en base (core.cron_runs) pour le tableau de bord admin.
#
# À sourcer APRÈS le chargement de nvm, avec APP_DIR défini. Jamais bloquant : si la base ou
# `pnpm cron-run` échoue, le cron continue normalement (le suivi est un confort, pas une dépendance).
#
# Usage :
#   cron_track_start "cron-daily" 10      # nom + nombre d'étapes prévues
#   cron_track_step  "scrape matchs"      # au début de chaque étape (incrémente le compteur)
#   cron_track_error                      # une étape a échoué
# Le statut final (success/failed) est posé automatiquement à la sortie du script (trap EXIT).

CRON_RUN_ID=""
CRON_STEP_N=0

_cron_run() { (cd "$APP_DIR" && pnpm --silent cron-run "$@" 2>/dev/null) || true; }

cron_track_start() {
  local id
  id=$(_cron_run start "$1" "${2:-0}" | tail -1)
  if [[ "$id" =~ ^[0-9]+$ ]]; then CRON_RUN_ID="$id"; fi
  CRON_STEP_N=0
  # Sortie normale ou erreur → statut final ; SIGTERM/SIGINT → on passe par exit pour déclencher le trap.
  trap '_cron_track_exit $?' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
}

cron_track_step() {
  [ -n "$CRON_RUN_ID" ] || return 0
  CRON_STEP_N=$((CRON_STEP_N + 1))
  _cron_run step "$CRON_RUN_ID" "$CRON_STEP_N" "$1" >/dev/null
}

cron_track_error() {
  [ -n "$CRON_RUN_ID" ] || return 0
  _cron_run error "$CRON_RUN_ID" >/dev/null
}

_cron_track_exit() {
  local rc="$1"
  [ -n "$CRON_RUN_ID" ] || return 0
  local id="$CRON_RUN_ID"
  CRON_RUN_ID=""
  if [ "$rc" -eq 0 ]; then
    _cron_run finish "$id" success >/dev/null
  else
    _cron_run finish "$id" failed "code de sortie $rc" >/dev/null
  fi
}
