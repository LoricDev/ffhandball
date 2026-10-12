#!/usr/bin/env bash
# deploy/deploy-all.sh — Orchestrateur déploiement clé-en-main ffhandball
# Usage : sudo ./deploy/deploy-all.sh
# Doit être lancé depuis la racine du repo (/opt/ffhandball)

set -euo pipefail

# ─── Vérifications préliminaires ─────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Ce script doit être lancé avec sudo." >&2
  echo "       Usage : sudo ./deploy/deploy-all.sh" >&2
  exit 1
fi

# Détecter l'utilisateur réel (celui qui a sudo-lancé)
REAL_USER="${SUDO_USER:-$USER}"
if [ "$REAL_USER" = "root" ]; then
  echo "ERROR: Ne pas lancer directement en tant que root." >&2
  echo "       Créer un utilisateur non-root et utiliser sudo." >&2
  exit 1
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export APP_DIR
export REAL_USER

echo "============================================================"
echo "  ffhandball — Déploiement clé-en-main"
echo "============================================================"
echo "  App dir  : $APP_DIR"
echo "  Run user : $REAL_USER"
echo "  Host     : $(hostname)"
echo "============================================================"
echo ""

# ─── Phase 1 : Dépendances OS ────────────────────────────────────────────────

echo ">>> Phase 1/2 : Installation des dépendances OS..."
bash "$APP_DIR/deploy/install-server.sh"
echo ">>> Phase 1/2 : OK"
echo ""

# ─── Phase 2 : Configuration application ─────────────────────────────────────

echo ">>> Phase 2/2 : Configuration de l'application..."
# Exécuter setup-app.sh en tant que l'utilisateur réel (pas root).
# -H : HOME = home de l'utilisateur (indispensable pour trouver nvm/Node dans ~/.nvm).
# NB : on n'utilise PAS -E (qui conserverait HOME=/root). APP_DIR et REAL_USER sont
# recalculés par setup-app.sh (défauts corrects : chemin du script + whoami).
sudo -u "$REAL_USER" -H bash "$APP_DIR/deploy/setup-app.sh"
echo ">>> Phase 2/2 : OK"
echo ""

# ─── Récapitulatif ───────────────────────────────────────────────────────────

echo "============================================================"
echo "  DEPLOIEMENT TERMINE"
echo "============================================================"
echo ""
echo "Commandes utiles :"
echo "  journalctl -u ffhandball-api -f          # logs API en direct"
echo "  systemctl status ffhandball-api           # statut API"
echo "  systemctl restart ffhandball-api          # redémarrer API"
echo "  crontab -u $REAL_USER -l                  # voir les cron"
echo "  ls /var/log/ffhandball/                   # logs cron"
echo ""
echo "IMPORTANT : Le premier scrape complet doit être lancé manuellement."
echo "  Voir docs/DEPLOY.md section 'Premier scrape complet'."
echo ""
echo "  cd $APP_DIR"
echo "  pnpm scrape --entity=competitions --saison=2025-2026"
echo ""
