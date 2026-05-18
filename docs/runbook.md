# Runbook

## Lancer un scrape

```bash
npm run scrape -- --entity=<entity> --saison=YYYY-YYYY [--url=...]
```

Le scraper :
1. Ouvre un `scrape_run` dans `raw.scrape_runs`
2. Récupère les pages avec rate-limit (cf. `SCRAPE_RATE_LIMIT_MS`)
3. Parse, valide via Zod, insère en `raw.<entity>`
4. Marque le run `success` / `failed` / `partial`

## Lancer un ETL

```bash
npm run etl -- --entity=<entity> --saison=YYYY-YYYY
```

L'ETL :
1. Sélectionne la version la plus récente par `(natural_key, saison)`
2. Valide (Zod), rejet → `core.etl_rejets`
3. Normalise (texte, dates, FKs)
4. UPSERT idempotent vers `core.<entity>`
5. Rapport dans `core.etl_runs`

## Inspecter les rejets / warnings

```sql
SELECT * FROM core.etl_runs ORDER BY started_at DESC LIMIT 10;

SELECT entity, reason, natural_key, payload
  FROM core.etl_rejets
  WHERE etl_run_id = <id>;

SELECT entity, natural_key, message
  FROM core.etl_warnings
  WHERE etl_run_id = <id>;
```

## Rejouer un ETL après bug de nettoyage

```sql
TRUNCATE core.clubs CASCADE;
```

Puis :
```bash
npm run etl -- --entity=clubs --saison=2025-2026
```

Les données `raw.clubs` ne sont pas touchées — pas besoin de rescraper.

## Reset complet de la base

```bash
npm run db:reset       # ⚠️ drop le volume Docker
npm run db:migrate
npm run db:seed
```

## Ajouter une nouvelle saison

```sql
INSERT INTO core.saisons (saison_code, date_debut, date_fin)
VALUES ('2026-2027', '2026-07-01', '2027-06-30');
```
