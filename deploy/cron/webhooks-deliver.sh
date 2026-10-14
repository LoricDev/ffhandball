#!/usr/bin/env bash
# deploy/cron/webhooks-deliver.sh
# Envoie les webhooks de résultats en attente (file core.webhook_deliveries). Lancé chaque minute.
# Test rapide en SQL d'abord : la plupart des minutes il n'y a rien à envoyer, on ne charge alors ni
# nvm ni Node (coût ~0).

set -euo pipefail

exec 9>/tmp/ffhandball-webhooks-deliver.lock
flock -n 9 || exit 0

APP_DIR="${APP_DIR:-/opt/ffhandball}"
LOG_DIR="/var/log/ffhandball"
LOG="$LOG_DIR/webhooks.log"
mkdir -p "$LOG_DIR"

DUE=$(docker exec ffhandball-postgres psql -U ffhandball -d ffhandball -At -c \
  "SELECT count(*) FROM core.webhook_deliveries d
     JOIN core.webhook_subscriptions s ON s.id = d.subscription_id
    WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND s.active" 2>/dev/null || echo 0)
[ "${DUE:-0}" -gt 0 ] || exit 0

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

cd "$APP_DIR"
{ echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${DUE} livraison(s) due(s)"; pnpm --silent webhooks:deliver; } >> "$LOG" 2>&1 || true
