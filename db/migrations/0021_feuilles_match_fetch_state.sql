-- db/migrations/0021_feuilles_match_fetch_state.sql
-- Cache d'état de fetch des feuilles de match (FdM) pour ne JAMAIS re-télécharger ce qui a déjà
-- été tiré de l'origine CloudFront. Chaque PDF FdM est un cache-miss systématique → la cause
-- directe des 405 est le VOLUME de cache-miss. Re-télécharger inutilement, c'est s'auto-brider.
--
-- Un fetch FdM a 3 issues. Le SUCCÈS va dans raw.feuilles_match (le NOT EXISTS du scrape l'exclut
-- déjà des runs suivants). Cette table couvre les 2 autres, qui sinon étaient re-téléchargées à
-- CHAQUE run, indéfiniment :
--   - 'parse_failed' : PDF téléchargé (200) mais parsing échoué. On STOCKE les bytes → re-parsing
--      offline après amélioration du parser (`pnpm scrape --entity=feuilles-match --reparse-cache`),
--      zéro réseau. C'est le seul cas où pdf_bytes est renseigné (sous-ensemble petit, borné aux
--      échecs : les succès n'ont pas besoin des bytes).
--   - 'not_found'    : 404 (FdM pas encore publiée). Pas de bytes. Cache négatif BORNÉ : passé
--      SCRAPE_FDM_MAX_AGE_DAYS après la date du match, on cesse de re-taper l'origine (la FdM ne
--      viendra plus) ; en deçà on retente (publication tardive).
CREATE TABLE IF NOT EXISTS raw.feuilles_match_fetch_state (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fdm_code        text        NOT NULL,
  saison          text        NOT NULL,
  source_url      text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('parse_failed', 'not_found')),
  http_status     integer     NOT NULL,
  pdf_bytes       bytea,            -- renseigné UNIQUEMENT si status = 'parse_failed'
  pdf_size_bytes  integer,
  content_type    text,
  attempts        integer     NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fdm_fetch_state UNIQUE (fdm_code, saison)
);

-- Index de l'anti-jointure du scrape (exclure les codes déjà en échec/abandon).
CREATE INDEX IF NOT EXISTS idx_fdm_fetch_state_lookup
  ON raw.feuilles_match_fetch_state (saison, fdm_code, status);
