# Modèle pour ajouter une nouvelle entité

Trois fichiers + deux branchements. Remplacer partout `entity`/`Entity` par le nom réel.

## 1. Copier les 3 fichiers

| Modèle | Destination |
|---|---|
| `entity.schema.ts`  | `src/schemas/<entity>.schema.ts` |
| `entity.scraper.ts` | `src/scrapers/ffhandball/<entity>.scraper.ts` |
| `entity.etl.ts`     | `src/etl/<entity>.etl.ts` |

## 2. Créer la table raw + la table core (migration)

Nouvelle migration `db/migrations/00XX_<entity>.sql` :

```sql
-- table de capture brute (réutilise le helper générique)
SELECT raw._create_capture_table('entity');

-- table structurée
CREATE TABLE IF NOT EXISTS core.entity (
  id            bigserial PRIMARY KEY,
  id_ffhb       text NOT NULL,
  nom           text NOT NULL,
  saison_code   text NOT NULL REFERENCES core.saisons(saison_code),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_entity_id_ffhb_saison UNIQUE (id_ffhb, saison_code)
);
```

Puis : `npm run db:migrate`

## 3. Brancher le scraper dans `src/cli/scrape.ts`

a) Importer le parser et écrire une fonction `scrapeEntity(saison, opts)` qui :
   - `startScrapeRun({ source_site, scraper_name: "entity", saison })`
   - boucle `tryFetchHtml(run, url)` → `parseEntity(...)` → `insertRaw("entity", {...})`
   - `run.finishSuccess()` / `finishFailure(err)`

b) Ajouter le `else if` dans `main()` :
```ts
} else if (args.entity === "entity") {
  await scrapeEntity(args.saison, { limit: args.limit });
}
```

## 4. Brancher l'ETL dans `src/cli/etl.ts`

```ts
import { runEntityEtl } from "@/etl/entity.etl.js";
// ...
} else if (args.entity === "entity") {
  report = await runEntityEtl(args.saison);
}
```

## 5. (optionnel) Ajouter au pipeline + au status

- `src/cli/pipeline.ts` : ajouter les étapes `scrape entity` / `etl entity` au bon endroit du tableau `PIPELINE` (respecter les dépendances de FK).
- `src/cli/status.ts` : ajouter `"entity"` dans `SCRAPE_ENTITIES` et/ou `ETL_ENTITIES`.

## 6. Tester

```bash
npm run scrape -- --entity=entity --saison=2025-2026 --limit=1
npm run etl    -- --entity=entity --saison=2025-2026
npm run typecheck
```
