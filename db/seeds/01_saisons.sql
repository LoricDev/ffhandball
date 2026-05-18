-- 01_saisons.sql
INSERT INTO core.saisons (saison_code, date_debut, date_fin) VALUES
  ('2023-2024', '2023-07-01', '2024-06-30'),
  ('2024-2025', '2024-07-01', '2025-06-30'),
  ('2025-2026', '2025-07-01', '2026-06-30')
ON CONFLICT (saison_code) DO NOTHING;
