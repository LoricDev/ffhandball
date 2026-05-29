-- db/migrations/0016_joueurs_licence_prefix_index.sql
-- Index fonctionnel sur le préfixe (7 chiffres) du numéro de licence = code club FFHB.
-- Accélère le matching licence→club de /clubs/:id_ffhb/matchs (couche "licence").
CREATE INDEX IF NOT EXISTS idx_joueurs_licence_prefix7
  ON core.joueurs (left(numero_licence, 7));
