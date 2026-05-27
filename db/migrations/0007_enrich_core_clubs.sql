-- Migration: 0007_enrich_core_clubs.sql
-- Enrichissement de core.clubs avec les champs détail extraits des fiches club
-- de monclub.ffhandball.fr. Idempotent : ADD COLUMN IF NOT EXISTS.

-- Detail page enrichments
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS slug                    text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS telephone               text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS email                   text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS site_web                text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS adresse_correspondance  text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS latitude                double precision;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS longitude               double precision;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS register_link           text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS logo_club               text;

-- License counts (4 sub-columns + computed sum)
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS nb_licence_senior_h     integer;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS nb_licence_senior_f     integer;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS nb_licence_jeunes_h     integer;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS nb_licence_jeunes_f     integer;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS effectif_estime         integer;

-- Index utile pour lookup par slug (utilisé par futurs ETL si on cross-réfère par slug)
CREATE INDEX IF NOT EXISTS idx_clubs_slug ON core.clubs (slug);
