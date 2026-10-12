# Déploiement clé-en-main ffhandball

Déploiement complet sur un VPS frais en **1 commande**.

## Pré-requis

- VPS Ubuntu 22.04+ ou Debian 12+
- Accès SSH root (ou sudo)
- (Optionnel) Un nom de domaine pointant vers l'IP du VPS pour HTTPS auto

## Étapes

### 1. Cloner le repo

```bash
sudo mkdir -p /opt/ffhandball
sudo chown $USER:$USER /opt/ffhandball
git clone https://github.com/LoricDev/ffhandball.git /opt/ffhandball
cd /opt/ffhandball
```

### 2. Lancer le déploiement

```bash
sudo ./deploy/deploy-all.sh
```

Le script demande interactivement :
- **Domaine** (ex: `api.exemple.fr`) — laisser vide pour ignorer HTTPS
- **Email de contact** — utilisé dans User-Agent scraping + Let's Encrypt
- **Mot de passe Postgres** — auto-généré si laissé vide (recommandé)

Durée : ~5-10 min (hors téléchargements Docker).

### 3. Vérifier

```bash
curl http://localhost:3000/health
# Ou si HTTPS configuré :
curl https://api.ton-domaine.fr/health
```

## Après le déploiement

**Le premier scrape complet doit être lancé manuellement** (trop long pour le déploiement initial — prévoir 2-5 jours pour les feuilles de match) :

```bash
cd /opt/ffhandball
# Voir docs/DEPLOY.md section "Premier scrape complet" pour la séquence complète
```

Les scrapes nocturnes automatiques démarrent dès la nuit suivante via crontab.

## Commandes utiles

```bash
# Logs API
journalctl -u ffhandball-api -f

# Statut API
systemctl status ffhandball-api

# Redémarrer API
systemctl restart ffhandball-api

# Logs cron
ls /var/log/ffhandball/

# Mettre à jour l'application
cd /opt/ffhandball && git pull && pnpm install --prod --frozen-lockfile && pnpm db:migrate
systemctl restart ffhandball-api
```

## Troubleshooting

| Symptôme | Diagnostic |
|---|---|
| API ne démarre pas | `journalctl -u ffhandball-api -f` |
| Postgres inaccessible | `docker compose ps` + `docker compose logs postgres` |
| nginx 502 | API pas démarrée — `systemctl status ffhandball-api` |
| certbot échoue | Vérifier que le domaine pointe bien sur l'IP du VPS |
| Cron ne tourne pas | `crontab -l` + vérifier `/var/log/ffhandball/cron-*.log` |
