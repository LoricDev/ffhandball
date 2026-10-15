-- Recherche floue /search?type=joueurs : la requête filtre sur (nom || ' ' || prenom) <% terme ;
-- sans index sur cette expression exacte, Postgres parcourait toute la table core.joueurs.
CREATE INDEX IF NOT EXISTS idx_joueurs_nom_prenom_trgm
  ON core.joueurs USING gin ((nom || ' ' || prenom) gin_trgm_ops);
