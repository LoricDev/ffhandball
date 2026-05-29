#!/usr/bin/env bash
# deploy/setup-app.sh — Configuration de l'application ffhandball
# Idempotent : peut être relancé sans casser l'existant.
# Lancé en tant que $REAL_USER (pas root) par deploy-all.sh.

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REAL_USER="${REAL_USER:-$(whoami)}"

log() { echo "[setup-app] $*"; }

# ─── Variables interactives ───────────────────────────────────────────────────

echo ""
echo "=== Configuration du déploiement ==="
echo ""

read -rp "Domaine API (ex: api.exemple.fr) [laisser vide = pas de HTTPS] : " DOMAIN
DOMAIN="${DOMAIN:-}"

CONTACT_EMAIL=""
if [ -n "$DOMAIN" ]; then
  read -rp "Email de contact (Let's Encrypt + User-Agent scraping) : " CONTACT_EMAIL
  while [ -z "$CONTACT_EMAIL" ]; do
    echo "  L'email est requis si un domaine est configuré."
    read -rp "Email de contact : " CONTACT_EMAIL
  done
fi

read -rsp "Mot de passe Postgres [Entrée = auto-généré 32 chars] : " POSTGRES_PASSWORD
echo ""
if [ -z "$POSTGRES_PASSWORD" ]; then
  POSTGRES_PASSWORD=$(tr -dc 'A-Za-z0-9!@#%^*_-' < /dev/urandom | head -c 32 || true)
  log "Mot de passe Postgres auto-généré (sauvegardez-le !)."
  echo "  POSTGRES_PASSWORD : $POSTGRES_PASSWORD"
  echo ""
fi

# Secret admin pour /admin/api-keys (toujours généré : prêt si tu actives l'auth plus tard).
ADMIN_SECRET=$(openssl rand -hex 32 2>/dev/null || tr -dc 'a-f0-9' < /dev/urandom | head -c 64)

DATE_NOW=$(date +%Y-%m-%d)

echo ""
echo "=== Résumé ==="
echo "  APP_DIR          : $APP_DIR"
echo "  DOMAIN           : ${DOMAIN:-<aucun — pas de HTTPS>}"
echo "  CONTACT_EMAIL    : ${CONTACT_EMAIL:-<aucun>}"
echo "  POSTGRES_PASSWORD: ****"
echo ""
read -rp "Continuer ? [o/N] : " CONFIRM
if [[ ! "$CONFIRM" =~ ^[oO]$ ]]; then
  echo "Annulé."
  exit 0
fi

# ─── Détection Node path ──────────────────────────────────────────────────────

log "Détection du chemin Node 20..."
NODE_PATH=$(bash -lc 'command -v node' 2>/dev/null || true)
if [ -z "$NODE_PATH" ]; then
  # Fallback via nvm explicite
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  NODE_PATH=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE_PATH" ]; then
  # Dernier recours : chercher directement le binaire installé par nvm (version la plus récente)
  NODE_PATH=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)
fi
if [ -z "$NODE_PATH" ]; then
  echo "ERROR: node introuvable dans \$HOME=$HOME (.nvm). Vérifier install-server.sh." >&2
  exit 1
fi
log "Node path : $NODE_PATH ($(${NODE_PATH} --version))"

# ─── 1. Fichier .env ──────────────────────────────────────────────────────────

ENV_FILE="$APP_DIR/.env"
TEMPLATE="$APP_DIR/deploy/.env.production.template"

if [ -f "$ENV_FILE" ]; then
  log ".env déjà présent — sauvegarde en .env.bak avant remplacement."
  cp "$ENV_FILE" "${ENV_FILE}.bak"
fi

log "Génération de .env depuis le template..."
sed \
  -e "s|{{DOMAIN}}|${DOMAIN}|g" \
  -e "s|{{CONTACT_EMAIL}}|${CONTACT_EMAIL}|g" \
  -e "s|{{POSTGRES_PASSWORD}}|${POSTGRES_PASSWORD}|g" \
  -e "s|{{ADMIN_SECRET}}|${ADMIN_SECRET}|g" \
  -e "s|{{DATE}}|${DATE_NOW}|g" \
  "$TEMPLATE" > "$ENV_FILE"

chmod 600 "$ENV_FILE"
log ".env créé (chmod 600)."

# ─── 2. Override docker-compose POSTGRES_PASSWORD ────────────────────────────

# Le docker-compose.yml lit POSTGRES_PASSWORD depuis l'environnement.
# On exporte la variable pour que docker compose la charge correctement.
# Pas de modification du docker-compose.yml — on utilise le .env qui le charge.
export POSTGRES_PASSWORD

# ─── 3. npm install ──────────────────────────────────────────────────────────

log "Installation des dépendances npm (production)..."
cd "$APP_DIR"

# Charger nvm pour cette session
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1 || true

npm install --omit=dev --silent
log "npm install OK."

# ─── 4. DB : up + migrate + seed ─────────────────────────────────────────────

log "Démarrage de Postgres via Docker Compose..."
cd "$APP_DIR"
npm run db:up

log "Attente que Postgres soit healthy (30s max)..."
ATTEMPTS=0
until docker exec ffhandball-postgres pg_isready -U ffhandball -d ffhandball &>/dev/null; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 30 ]; then
    echo "ERROR: Postgres non prêt après 30 tentatives." >&2
    docker compose logs postgres
    exit 1
  fi
  sleep 1
done
log "Postgres OK."

log "Exécution des migrations..."
npm run db:migrate
log "Migrations OK."

log "Exécution des seeds..."
npm run db:seed
log "Seeds OK."

# ─── 5. systemd service ───────────────────────────────────────────────────────

SERVICE_TEMPLATE="$APP_DIR/deploy/systemd/ffhandball-api.service.template"
SERVICE_FILE="/etc/systemd/system/ffhandball-api.service"

log "Génération du service systemd..."
# Générer le fichier service dans un tmp, puis le déplacer en root
TMP_SERVICE=$(mktemp)
sed \
  -e "s|{{USER}}|${REAL_USER}|g" \
  -e "s|{{APP_DIR}}|${APP_DIR}|g" \
  -e "s|{{NODE_PATH}}|${NODE_PATH}|g" \
  "$SERVICE_TEMPLATE" > "$TMP_SERVICE"

# Nécessite sudo pour écrire dans /etc/systemd
if [ "$(id -u)" -eq 0 ]; then
  mv "$TMP_SERVICE" "$SERVICE_FILE"
  chmod 644 "$SERVICE_FILE"
else
  sudo mv "$TMP_SERVICE" "$SERVICE_FILE"
  sudo chmod 644 "$SERVICE_FILE"
fi

log "Service systemd installé : $SERVICE_FILE"

log "Activation et démarrage du service..."
if [ "$(id -u)" -eq 0 ]; then
  systemctl daemon-reload
  systemctl enable ffhandball-api
  systemctl restart ffhandball-api
else
  sudo systemctl daemon-reload
  sudo systemctl enable ffhandball-api
  sudo systemctl restart ffhandball-api
fi
log "Service ffhandball-api démarré."

# ─── 6. nginx + certbot (optionnel) ──────────────────────────────────────────

if [ -n "$DOMAIN" ]; then
  NGINX_TEMPLATE="$APP_DIR/deploy/nginx/ffhandball-api.conf.template"
  NGINX_CONF="/etc/nginx/sites-available/ffhandball-api.conf"
  NGINX_LINK="/etc/nginx/sites-enabled/ffhandball-api.conf"

  log "Génération de la configuration nginx pour $DOMAIN..."
  TMP_NGINX=$(mktemp)
  sed \
    -e "s|{{DOMAIN}}|${DOMAIN}|g" \
    "$NGINX_TEMPLATE" > "$TMP_NGINX"

  if [ "$(id -u)" -eq 0 ]; then
    mv "$TMP_NGINX" "$NGINX_CONF"
    chmod 644 "$NGINX_CONF"
    # Lien symlink idempotent
    ln -sf "$NGINX_CONF" "$NGINX_LINK"
    nginx -t
    systemctl reload nginx
  else
    sudo mv "$TMP_NGINX" "$NGINX_CONF"
    sudo chmod 644 "$NGINX_CONF"
    sudo ln -sf "$NGINX_CONF" "$NGINX_LINK"
    sudo nginx -t
    sudo systemctl reload nginx
  fi
  log "nginx configuré pour $DOMAIN."

  log "Configuration HTTPS via Let's Encrypt (certbot)..."
  CERTBOT_CMD="certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m $CONTACT_EMAIL --redirect"
  if [ "$(id -u)" -eq 0 ]; then
    $CERTBOT_CMD
  else
    sudo $CERTBOT_CMD
  fi
  log "HTTPS configuré via Let's Encrypt."

  if [ "$(id -u)" -eq 0 ]; then
    nginx -t && systemctl reload nginx
  else
    sudo nginx -t && sudo systemctl reload nginx
  fi
  log "nginx rechargé avec la config HTTPS."
else
  log "Aucun domaine défini — setup nginx/HTTPS ignoré."
fi

# ─── 7. Cron jobs ─────────────────────────────────────────────────────────────

log "Installation des cron jobs..."
chmod +x "$APP_DIR/deploy/cron/"*.sh
bash "$APP_DIR/deploy/cron/install-crontab.sh"
log "Cron jobs installés."

# ─── 8. Smoke test ────────────────────────────────────────────────────────────

log "Smoke test : curl http://localhost:3000/health..."
sleep 3  # Laisser le temps au service de démarrer
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health || true)
if [ "$HTTP_CODE" = "200" ]; then
  log "Smoke test OK (HTTP 200)."
else
  echo "WARNING: Smoke test retourné HTTP $HTTP_CODE — vérifier les logs." >&2
  echo "  journalctl -u ffhandball-api -f" >&2
fi

# ─── Récapitulatif ────────────────────────────────────────────────────────────

echo ""
echo "=== Application configurée ==="
if [ -n "$DOMAIN" ]; then
  echo "  API publique : https://$DOMAIN"
fi
echo "  API locale   : http://localhost:3000"
echo "  Logs API     : journalctl -u ffhandball-api -f"
echo "  Statut       : systemctl status ffhandball-api"
echo ""
echo "IMPORTANT : Sauvegarder ces secrets (aussi dans $ENV_FILE) :"
echo "  POSTGRES_PASSWORD : $POSTGRES_PASSWORD"
echo "  ADMIN_SECRET      : $ADMIN_SECRET"
echo ""
echo "Auth API : désactivée (API_AUTH_ENABLED=false). Pour facturer :"
echo "  1) npm run apikey -- create --label=<email> --months=1   # 1re clé"
echo "  2) Passer API_AUTH_ENABLED=true dans $ENV_FILE"
echo "  3) sudo systemctl restart ffhandball-api"
echo ""
