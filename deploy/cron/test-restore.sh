#!/usr/bin/env bash
# deploy/cron/test-restore.sh
# Test de restauration : un backup qu'on n'a jamais restauré n'est pas un backup.
# Restaure le dernier dump core.* dans une base TEMPORAIRE, compare les volumes des tables clés
# avec la base réelle, puis supprime la base temporaire. Mail en cas d'échec.
# Lancé le 9 de chaque mois à 08:00 par le crontab utilisateur.

set -euo pipefail

exec 9>/tmp/ffhandball-test-restore.lock
flock -n 9 || { echo "test-restore déjà en cours, abandon."; exit 0; }

APP_DIR="${APP_DIR:-/opt/ffhandball}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ffhandball}"
CONTAINER="ffhandball-postgres"
PG_USER="ffhandball"
LIVE_DB="ffhandball"
TMP_DB="ffhandball_restore_test"
DATE_NOW=$(date +%Y-%m-%d)
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/test-restore-$DATE_NOW.log"
mkdir -p "$LOG_DIR"

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
log_err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; }

source "$(dirname "$0")/lib-notify.sh"
source "$(dirname "$0")/lib-cron.sh"
cd "$APP_DIR"
cron_track_start "test-restore" 3

psql_live() { docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$LIVE_DB" -At -q "$@"; }
psql_tmp()  { docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$TMP_DB" -At -q "$@"; }

cleanup() {
  docker exec "$CONTAINER" psql -U "$PG_USER" -d "$LIVE_DB" -q -c "DROP DATABASE IF EXISTS $TMP_DB" >> "$LOG" 2>&1 || true
}
fail() {
  log_err "ECHEC : $1"
  notify_failure "test-restore" 1 "$LOG"
  exit 1
}
trap 'cleanup' EXIT

log "=== Démarrage test-restore ==="

BACKUP=$(ls -1t "$BACKUP_DIR"/core-*.sql.gz 2>/dev/null | head -1 || true)
[ -n "$BACKUP" ] || fail "aucun backup trouvé dans $BACKUP_DIR"
log "Backup testé : $BACKUP ($(du -h "$BACKUP" | cut -f1))"

# Place disponible : la base restaurée occupe plusieurs fois la taille du dump compressé.
NEED_KB=$(( $(stat -c %s "$BACKUP") / 1024 * 8 ))
FREE_KB=$(df --output=avail -k / | tail -1 | tr -dc '0-9')
[ "$FREE_KB" -gt "$NEED_KB" ] || fail "espace disque insuffisant pour le test (libre ${FREE_KB} Ko, besoin ~${NEED_KB} Ko)"

cron_track_step "restauration dans $TMP_DB"
cleanup
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$LIVE_DB" -q -c "CREATE DATABASE $TMP_DB" >> "$LOG" 2>&1 \
  || fail "impossible de créer la base temporaire $TMP_DB"
# Le dump ne contient que le schéma core : l'extension pg_trgm (index gin_trgm_ops) doit exister AVANT.
psql_tmp -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >> "$LOG" 2>&1 || fail "impossible de créer l'extension pg_trgm"
START=$(date +%s)
if ! gunzip -c "$BACKUP" | docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$TMP_DB" -q -v ON_ERROR_STOP=1 >> "$LOG" 2>&1; then
  fail "la restauration a échoué (voir le log) — le backup n'est PAS exploitable"
fi
log "Restauration terminée en $(( $(date +%s) - START )) s."

cron_track_step "contrôle des volumes"
BAD=0
for t in clubs competitions equipes matchs joueurs classements; do
  live=$(psql_live -c "SELECT count(*) FROM core.$t")
  rest=$(psql_tmp -c "SELECT count(*) FROM core.$t" 2>/dev/null || echo "ERR")
  if [ "$rest" = "ERR" ] || [ "$rest" -le 0 ] || [ "$rest" -lt $(( live * 9 / 10 )) ]; then
    log_err "core.$t : $rest ligne(s) restaurée(s) pour $live en base — suspect"
    BAD=$((BAD + 1))
  else
    log "core.$t : $rest restaurées / $live en base — OK"
  fi
done
[ "$BAD" -eq 0 ] || fail "$BAD table(s) incohérente(s) après restauration"

cron_track_step "nettoyage"
cleanup
log "=== test-restore terminé avec succès : le backup est restaurable ==="
