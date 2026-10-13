# Alerte mail immédiate quand un cron se termine en erreur (sinon l'échec n'est visible
# que dans le log, ou dans le récap de 07:00). À sourcer APRÈS le chargement de nvm, avec
# APP_DIR défini. Usage : notify_failure "<nom du cron>" "<nb erreurs>" "<fichier log>"
# Ne fait jamais échouer le cron appelant (|| true).
notify_failure() {
  local name="$1" errors="$2" logfile="$3"
  local host last
  host=$(hostname 2>/dev/null || echo "serveur")
  # Dernières étapes en échec (lignes "ECHEC" écrites par run_step), compactées sur une ligne.
  last=$(grep -E "ECHEC" "$logfile" 2>/dev/null | tail -n 3 | sed -E 's/^\[[^]]*\] *(ERROR: *)?//' | tr '\n' ';' || true)
  (cd "$APP_DIR" && pnpm notify "[ffhandball] ❌ ${name} en échec" \
    "${name} s'est terminé avec ${errors} erreur(s) sur ${host}. ${last} Log : ${logfile}" \
    >> "$logfile" 2>&1) || true
}
