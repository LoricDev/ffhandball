-- db/migrations/0033_matchs_date_a_confirmer.sql
-- Match dont la date exacte n'est pas encore connue (ffhandball.fr n'affiche que la journée) :
-- date_heure prend alors le début de la journée, date_a_confirmer vaut true, et la fenêtre de la
-- journée est exposée (journee_date_debut / journee_date_fin) pour afficher « semaine du … ».
ALTER TABLE core.matchs
  ADD COLUMN IF NOT EXISTS date_a_confirmer   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS journee_date_debut date,
  ADD COLUMN IF NOT EXISTS journee_date_fin   date;
