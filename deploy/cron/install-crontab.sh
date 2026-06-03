#!/usr/bin/env bash
# deploy/cron/install-crontab.sh
# Installe les cron jobs ffhandball dans le crontab de l'utilisateur courant.
# Idempotent : ne crée pas de doublons. Ne touche pas aux autres cron du user.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ffhandball}"

MARKER_START="# --- ffhandball pipeline BEGIN ---"
MARKER_END="# --- ffhandball pipeline END ---"

CRON_BLOCK="$MARKER_START
# Mise à jour quotidienne : matchs + ETL cascade + classements + FdM récentes + stats-joueurs (02:00)
0 2 * * *   $APP_DIR/deploy/cron/cron-daily.sh
# Monitoring : santé runs + fraîcheur + qualité, alerte mail (07:00)
0 7 * * *   $APP_DIR/deploy/cron/cron-monitor.sh
# Healthcheck API toutes les 5 min (alerte une fois par incident)
*/5 * * * * $APP_DIR/deploy/cron/cron-healthcheck.sh
# Feuilles de match récentes (hebdo lundi 03:00)
0 3 * * 1   $APP_DIR/deploy/cron/cron-weekly-fdm-recent.sh
# Refresh structurel : clubs/compétitions/poules/équipes (hebdo dimanche 05:00)
0 5 * * 0   $APP_DIR/deploy/cron/cron-weekly-structure.sh
# Maintenance : purge api_logs + VACUUM + rotation logs (hebdo dimanche 06:00)
0 6 * * 0   $APP_DIR/deploy/cron/cron-maintenance.sh
# Rattrapage FdM complet (mensuel 1er du mois 22:00 — peut durer plusieurs nuits)
0 22 1 * *  $APP_DIR/deploy/cron/cron-monthly-fdm-full.sh
# Backup core.* quotidien avec rotation 14j (04:30)
30 4 * * *  $APP_DIR/deploy/cron/backup-daily.sh
$MARKER_END"

# Lire le crontab actuel (peut être vide sur un VPS frais)
CURRENT_CRONTAB=$(crontab -l 2>/dev/null || true)

# Supprimer l'éventuel bloc ffhandball existant (entre les markers) — idempotence
FILTERED=$(echo "$CURRENT_CRONTAB" | awk "
  /$MARKER_START/ { skip=1 }
  !skip { print }
  /$MARKER_END/ { skip=0 }
")

# Reconstruire le crontab avec le nouveau bloc
NEW_CRONTAB="${FILTERED:+$FILTERED
}$CRON_BLOCK"

echo "$NEW_CRONTAB" | crontab -

echo "[install-crontab] Cron jobs ffhandball installés :"
echo "  0 2 * * *   cron-daily.sh"
echo "  0 7 * * *   cron-monitor.sh"
echo "  */5 * * * * cron-healthcheck.sh"
echo "  0 3 * * 1   cron-weekly-fdm-recent.sh"
echo "  0 5 * * 0   cron-weekly-structure.sh"
echo "  0 6 * * 0   cron-maintenance.sh"
echo "  0 22 1 * *  cron-monthly-fdm-full.sh"
echo "  30 4 * * *  backup-daily.sh"
echo ""
echo "Vérifier avec : crontab -l"
