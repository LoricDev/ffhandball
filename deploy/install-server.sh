#!/usr/bin/env bash
# deploy/install-server.sh — Installation des dépendances OS
# Idempotent : peut être relancé sans casser l'existant.
# Doit être lancé en root (via deploy-all.sh).

set -euo pipefail

REAL_USER="${REAL_USER:-${SUDO_USER:-}}"
if [ -z "$REAL_USER" ]; then
  echo "ERROR: REAL_USER non défini. Lancer via deploy-all.sh" >&2
  exit 1
fi

log() { echo "[install-server] $*"; }

# ─── Mise à jour système ──────────────────────────────────────────────────────

log "Mise à jour des paquets système..."
apt-get update -qq
apt-get upgrade -y -qq

# ─── Outils de base ──────────────────────────────────────────────────────────

log "Installation des outils de base..."
apt-get install -y -qq curl git build-essential ufw

# ─── Docker ──────────────────────────────────────────────────────────────────

if command -v docker &>/dev/null; then
  log "Docker déjà installé ($(docker --version)) — skip."
else
  log "Installation de Docker..."
  curl -fsSL https://get.docker.com | sh
  log "Docker installé."
fi

# Ajouter l'utilisateur au groupe docker (idempotent)
if id -nG "$REAL_USER" | grep -qw docker; then
  log "Utilisateur $REAL_USER déjà dans le groupe docker — skip."
else
  usermod -aG docker "$REAL_USER"
  log "Utilisateur $REAL_USER ajouté au groupe docker."
  log "ATTENTION : Le groupe docker prendra effet à la prochaine session SSH."
fi

# S'assurer que docker est démarré
systemctl enable --now docker

# ─── nvm + Node 20 ───────────────────────────────────────────────────────────

NVM_VERSION="v0.40.1"
# Vérifier si nvm est déjà installé pour cet utilisateur
NVM_DIR_USER="/home/$REAL_USER/.nvm"
if [ -d "$NVM_DIR_USER" ] && sudo -u "$REAL_USER" -- bash -lc 'command -v node' &>/dev/null; then
  NODE_VER=$(sudo -u "$REAL_USER" -- bash -lc 'node --version')
  log "nvm + Node déjà installé ($NODE_VER) — skip."
else
  log "Installation de nvm $NVM_VERSION pour $REAL_USER..."
  sudo -u "$REAL_USER" -- bash -c "
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash
  "
  log "Installation de Node 20 via nvm..."
  sudo -u "$REAL_USER" -- bash -lc "
    export NVM_DIR=\"\$HOME/.nvm\"
    [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
    nvm install 20
    nvm alias default 20
    nvm use 20
  "
  log "Node 20 installé."
fi

# ─── pnpm via corepack ─────────────────────────────────────────────────────────

log "Activation de pnpm via corepack..."
sudo -u "$REAL_USER" -- bash -lc '
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm use 20 > /dev/null 2>&1 || true
  corepack enable pnpm
  corepack prepare pnpm@10.33.4 --activate
  echo "pnpm $(pnpm --version) prêt."
'
log "pnpm activé."

# ─── nginx ───────────────────────────────────────────────────────────────────

if command -v nginx &>/dev/null; then
  log "nginx déjà installé ($(nginx -v 2>&1)) — skip."
else
  log "Installation de nginx..."
  apt-get install -y -qq nginx
  systemctl enable --now nginx
  log "nginx installé."
fi

# ─── certbot ─────────────────────────────────────────────────────────────────

if command -v certbot &>/dev/null; then
  log "certbot déjà installé — skip."
else
  log "Installation de certbot..."
  apt-get install -y -qq certbot python3-certbot-nginx
  log "certbot installé."
fi

# ─── ufw firewall ────────────────────────────────────────────────────────────

log "Configuration du firewall ufw..."
# Ces commandes sont idempotentes
ufw --force reset > /dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow http
ufw allow https
# Activer sans question interactive
ufw --force enable
log "Firewall ufw configuré (SSH + HTTP + HTTPS autorisés)."

# ─── Répertoire logs ─────────────────────────────────────────────────────────

log "Création du répertoire de logs /var/log/ffhandball..."
mkdir -p /var/log/ffhandball
chown "$REAL_USER:$REAL_USER" /var/log/ffhandball
chmod 755 /var/log/ffhandball

log "install-server.sh terminé."
