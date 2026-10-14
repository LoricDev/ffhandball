-- db/migrations/0025_webhooks.sql
-- Webhooks de résultats : un abonné reçoit un POST signé quand un match passe à « joué » / « forfait »
-- ou voit son score changer.
--
--   core.webhook_subscriptions : les abonnements (URL, secret de signature, filtre club optionnel)
--   core.match_events          : journal des événements (alimenté par un trigger sur core.matchs)
--   core.webhook_deliveries    : file d'envoi (une ligne par abonné et par événement, avec reprises)
--
-- Les livraisons ne sont créées que pour les abonnements ACTIFS au moment de l'événement :
-- un nouvel abonné ne reçoit pas l'historique.

CREATE TABLE IF NOT EXISTS core.webhook_subscriptions (
  id                    bigserial PRIMARY KEY,
  label                 text,
  url                   text        NOT NULL,
  secret                text        NOT NULL,
  -- Filtre optionnel : id_ffhb du club ; seuls les matchs dont une équipe porte ce club
  -- (equipes.ext_structure_id) sont envoyés. Les ententes ne sont pas couvertes.
  club_id_ffhb          text,
  active                boolean     NOT NULL DEFAULT true,
  disabled_reason       text,
  consecutive_failures  integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.match_events (
  id          bigserial PRIMARY KEY,
  match_id    bigint      REFERENCES core.matchs(id) ON DELETE CASCADE,
  event       text        NOT NULL,   -- 'match.result' | 'ping'
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_match_events_created ON core.match_events (created_at);

CREATE TABLE IF NOT EXISTS core.webhook_deliveries (
  id               bigserial PRIMARY KEY,
  subscription_id  bigint      NOT NULL REFERENCES core.webhook_subscriptions(id) ON DELETE CASCADE,
  event_id         bigint      NOT NULL REFERENCES core.match_events(id) ON DELETE CASCADE,
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status      integer,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_delivery UNIQUE (subscription_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON core.webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Trigger : un résultat nouveau ou modifié → événement + livraisons pour les abonnés concernés.
CREATE OR REPLACE FUNCTION core.emit_match_result_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_payload  jsonb;
  v_event_id bigint;
  v_dom_club text;
  v_ext_club text;
BEGIN
  IF NEW.statut NOT IN ('joue', 'forfait') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.statut        IS NOT DISTINCT FROM NEW.statut
     AND OLD.score_dom     IS NOT DISTINCT FROM NEW.score_dom
     AND OLD.score_ext     IS NOT DISTINCT FROM NEW.score_ext
     AND OLD.forfait_equipe IS NOT DISTINCT FROM NEW.forfait_equipe THEN
    RETURN NEW;
  END IF;
  -- Rien à faire (et rien à stocker) s'il n'y a aucun abonné actif.
  IF NOT EXISTS (SELECT 1 FROM core.webhook_subscriptions WHERE active) THEN
    RETURN NEW;
  END IF;

  SELECT ed.ext_structure_id, ee.ext_structure_id,
         jsonb_build_object(
           'id_ffhb_match',  NEW.id_ffhb_match,
           'date_heure',     NEW.date_heure,
           'statut',         NEW.statut,
           'forfait_equipe', NEW.forfait_equipe,
           'journee',        NEW.journee,
           'score_dom',      NEW.score_dom,
           'score_ext',      NEW.score_ext,
           'score_mt_dom',   NEW.score_mt_dom,
           'score_mt_ext',   NEW.score_mt_ext,
           'equipe_dom',     jsonb_build_object('id_ffhb', ed.id_ffhb, 'nom', ed.nom),
           'equipe_ext',     jsonb_build_object('id_ffhb', ee.id_ffhb, 'nom', ee.nom),
           'poule_id_ffhb',  po.id_ffhb,
           'competition_nom', c.nom,
           'saison',         po.saison_code
         )
    INTO v_dom_club, v_ext_club, v_payload
    FROM core.equipes ed, core.equipes ee, core.poules po, core.phases ph, core.competitions c
   WHERE ed.id = NEW.equipe_dom_id AND ee.id = NEW.equipe_ext_id
     AND po.id = NEW.poule_id AND ph.id = po.phase_id AND c.id = ph.competition_id;

  IF v_payload IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.match_events (match_id, event, payload)
  VALUES (NEW.id, 'match.result', v_payload)
  RETURNING id INTO v_event_id;

  INSERT INTO core.webhook_deliveries (subscription_id, event_id)
  SELECT s.id, v_event_id
    FROM core.webhook_subscriptions s
   WHERE s.active
     AND (s.club_id_ffhb IS NULL OR s.club_id_ffhb IN (v_dom_club, v_ext_club));

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_matchs_emit_result ON core.matchs;
CREATE TRIGGER trg_matchs_emit_result
  AFTER INSERT OR UPDATE OF statut, score_dom, score_ext, forfait_equipe ON core.matchs
  FOR EACH ROW EXECUTE FUNCTION core.emit_match_result_event();
