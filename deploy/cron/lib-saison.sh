# Saison courante (bascule le 1er juillet). Surchargeable avec SAISON=2026-2027.
if [ -z "${SAISON:-}" ]; then
  _y=$(date +%Y); _m=$((10#$(date +%m)))
  if [ "$_m" -ge 7 ]; then _s=$_y; else _s=$((_y - 1)); fi
  SAISON="$_s-$((_s + 1))"
fi
