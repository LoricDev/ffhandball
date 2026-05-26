---
name: Enrichissement clubs + entité salles
description: Design de la passe 2 du pipeline ffhandball — scraping des fiches détail club pour alimenter raw.salles et enrichir raw.clubs/core.clubs
type: spec
date: 2026-05-26
---

# Enrichissement clubs et entité `salles`

## Contexte

Le pilote `clubs` a livré une première passe légère : scraping de la **page de listing** `ffhandball.fr/clubs` → `raw.clubs` (payload minimal : `id_ffhb`, `nom`, `ville`, `departement_code`) → `core.clubs` (sans `salle_principale_id`, sans contacts).

Cette spec couvre la **passe 2** : visiter chaque fiche détail club pour en extraire la salle principale et les champs club additionnels. Elle livre la deuxième entité du pipeline (`salles`) et enrichit la première (`clubs`), sans toucher aux autres.

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Alimenter `core.salles` à partir des fiches détail club (une salle principale par club, quand exposée)
- Enrichir `core.clubs` : `salle_principale_id` + colonnes supplémentaires découvertes (téléphone, email, site web…)
- Préserver l'idempotence et la traçabilité (`raw.scrape_runs`, `core.etl_runs`, `core.etl_warnings`, `core.etl_rejets`)
- Garder l'option future "salles de match" : la table `core.salles` doit pouvoir accueillir des salles découvertes via les scrapers `matchs` plus tard sans schéma rework

## Non-objectifs

- Pas de scraping de `monclub.ffhandball.fr` dans cette passe
- Pas de scraping des salles de match (déféré à l'entité `matchs`)
- Pas d'API publique sur `core.salles` (déféré)
- Pas de géocodage / coordonnées GPS (à voir si la fiche les expose, sinon hors scope)

## Architecture

```
[passe 1, déjà fait]
ffhandball.fr/clubs (listing)
        → parseClubsListing
        → raw.clubs (payload léger)
        → clubs.etl
        → core.clubs (sans salle)

[passe 2, ce design]
core.clubs (iterate)
        → fetch ffhandball.fr/clubs/<id_ffhb> (fiche détail)
        → parseClubDetail → { clubPayload (enrichi), sallePayload (ou null) }
        → raw.clubs (nouveau payload, plus récent)
        → raw.salles (nouveau)
        → salles.etl  → core.salles
        → clubs.etl   → core.clubs enrichi + salle_principale_id résolu
```

**Une seule requête HTTP par club**, deux insertions raw, deux ETL distincts en aval. L'ordre d'exécution attendu : `scrape club-details` → `etl salles` → `etl clubs`.

## Composants

### Nouveaux fichiers

- `src/scrapers/ffhandball/club-details.scraper.ts` — fonction pure `parseClubDetail(html, sourceUrl) → { club, salle }`
- `src/schemas/salle.schema.ts` — schéma Zod du payload `raw.salles`
- `src/etl/salles.etl.ts` — pipeline `raw.salles → core.salles`
- `db/migrations/0007_enrich_core_clubs.sql` — `ALTER TABLE` idempotent pour les colonnes confirmées par l'exploration
- `tests/fixtures/ffhandball-club-detail-{minimal,complet,sans-salle}.html` — 3 fixtures représentatives
- `tests/scrapers/club-details.scraper.test.ts`
- `tests/etl/salles.etl.test.ts`
- `tests/integration/club-details-end-to-end.test.ts`
- `docs/club-detail-fields.md` — output documentaire de l'exploration

### Fichiers modifiés

- `src/schemas/club.schema.ts` — ajout de champs **optionnels** (rétrocompat avec payloads passe 1)
- `src/etl/clubs.etl.ts` — résolution `salle_principale_id` via `core.salles.id_ffhb`, mappage des nouveaux champs
- `src/cli/scrape.ts` — accepte `--entity=club-details [--limit=N] [--id-ffhb=X]`
- `src/cli/etl.ts` — accepte `--entity=salles`
- `docs/runbook.md` — nouvelle section "Enrichir les clubs avec salles"

## Schémas de données

### `raw.salles.payload` (Zod, point de départ minimal)

```ts
export const rawSallePayloadSchema = z.object({
  id_ffhb: z.string().min(1),
  nom: z.string().min(1),
  adresse: z.string().optional(),
  code_postal: z.string().optional(),
  ville: z.string().optional(),
  departement_code: z.string().optional(),
  capacite: z.coerce.number().int().positive().optional(),
  source_url: z.string().url(),
  source_club_id_ffhb: z.string().min(1),
});
```

**natural_key salles** : `id_ffhb` quand exposé par le site, sinon fallback déterministe `slug(nom + code_postal + ville)`. La règle fallback est tranchée à l'exploration.

### Extension `rawClubPayloadSchema`

Tous les champs ajoutés sont `optional()` pour que les payloads listing passe 1 restent valides :

```ts
telephone: z.string().optional(),
email: z.string().email().optional(),
site_web: z.string().url().optional(),
adresse_correspondance: z.string().optional(),
salle_principale_id_ffhb: z.string().optional(),
effectif_estime: z.coerce.number().int().nonnegative().optional(),
```

La liste exacte est figée à l'issue de l'exploration. Les noms ci-dessus sont des hypothèses.

### `core.salles` (déjà créé en migration 0002)

Aucun changement de schéma sauf surprise à l'exploration. Si l'exploration révèle des champs inattendus (GPS, code IRIS), une migration `0008_extend_core_salles.sql` est ajoutée.

### `core.clubs` enrichi

Migration `0007_enrich_core_clubs.sql` :

```sql
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS telephone   text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS email       text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS site_web    text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS adresse_correspondance text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS effectif_estime integer;
-- salle_principale_id existe déjà (migration 0003)
```

Les colonnes finales sont figées après l'exploration.

## Étape exploratoire (préalable au code)

Un script jetable `scripts/explore-club-detail.ts` (non versionné en `src/`) :

1. Sélectionne ~8 clubs représentatifs depuis `core.clubs` : grand club D1, petit club départemental, club d'outre-mer, club sans salle déclarée, etc.
2. Fetch chaque fiche détail à `https://www.ffhandball.fr/clubs/<id_ffhb>` (pattern URL à confirmer)
3. Dump le HTML dans `tests/fixtures/club-detail-<id>.html`
4. Liste manuellement les champs observés dans `docs/club-detail-fields.md` :
   - quels sélecteurs CSS pour chaque champ
   - quels champs sont toujours présents, parfois, jamais
   - cas dégradés (clubs sans salle, sans contact…)

Ce livrable conditionne la finalisation des schémas Zod et de la migration 0007.

## Idempotence

- `raw.salles` : règle de dédup identique à `raw.clubs` — skip insert si `(natural_key, saison, payload_hash)` déjà présent (cf. `raw-insert.ts`)
- `core.salles` : `UPSERT ON CONFLICT (id_ffhb)`
- `core.clubs` enrichi : le ETL `clubs` consomme la version la plus récente par `(natural_key, saison)`, donc le payload enrichi de la passe 2 prend automatiquement la main sur le payload listing de la passe 1
- Re-runs : `rows_noop` augmente, pas de duplicats

## Résolution des FKs

- `core.salles.departement_id` : `resolveDepartementCode(code)` (helper existant). FK non résolue → **warning**, ligne insérée sans FK
- `core.clubs.salle_principale_id` : `SELECT id FROM core.salles WHERE id_ffhb = $1` inline dans `clubs.etl`. Salle absente de `core.salles` → **warning**, FK reste NULL, sera résolue au prochain re-run

Pas de dépendance circulaire : `core.salles` n'a pas de FK vers `core.clubs` (le `source_club_id_ffhb` reste cantonné à `raw.salles` à des fins de traçabilité).

## Politique de scraping

Réutilise `src/scrapers/shared/http-client.ts` :
- `SCRAPE_USER_AGENT` identifiable
- Rate limit ≥ 1500 ms par domaine
- Retry x3
- Scrape nocturne recommandé pour le run complet

Volumétrie : ~2000 clubs nationaux → ~50 min de run complet à 1.5 s/req. Le drapeau `--limit=N` et `--id-ffhb=X` permettent d'itérer en dev sans charger le serveur.

## CLI

```bash
# Scrape une seule fiche, utile en dev / debug
npm run scrape -- --entity=club-details --saison=2025-2026 --id-ffhb=1234

# Scrape 50 fiches pour valider en intégration
npm run scrape -- --entity=club-details --saison=2025-2026 --limit=50

# Scrape complet, à programmer en nocturne
npm run scrape -- --entity=club-details --saison=2025-2026

# Puis les deux ETL dans l'ordre
npm run etl -- --entity=salles --saison=2025-2026
npm run etl -- --entity=clubs  --saison=2025-2026
```

## Tests

- **Unitaires scraper** (Vitest + fixtures) : 3 fixtures → 3 cas de parsing (complet, minimal, sans salle, HTML cassé)
- **Unitaires ETL salles** : payload valide, payload Zod-invalide → rejet, département inconnu → warning, idempotence
- **Intégration end-to-end** : fetch mocké, vérifie le contenu final de `core.salles` et la résolution `core.clubs.salle_principale_id`

Pas de test live contre `ffhandball.fr` — toujours via fixtures.

## Traçabilité

Chaque exécution produit :
- 1 ligne dans `raw.scrape_runs` (status, pages_scraped, durée)
- 2 lignes dans `core.etl_runs` (entity = salles, entity = clubs)
- N lignes dans `core.etl_warnings` (FK non résolues, formats inattendus)
- M lignes dans `core.etl_rejets` (payloads Zod-invalide)

Requêtes SQL types dans le runbook pour suivre la couverture (`% de clubs avec salle_principale_id`).

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| L'URL des fiches détail change ou n'est pas devinable depuis `id_ffhb` | Exploration manuelle d'abord, on confirme le pattern URL avant d'écrire le scraper |
| Le HTML n'expose pas d'`id_ffhb` distinct pour la salle | Fallback `slug(nom + code_postal + ville)` comme natural_key, décidé à l'exploration |
| Beaucoup de clubs sans salle déclarée | Acceptable : `salle_principale_id` NULL est valide, warning loggué |
| ~50 min de scraping en un seul run | `--limit` pour tests, scrapes nocturnes pour le complet |
| Changement HTML côté ffhandball.fr | Tests fixtures cassent vite, on update les sélecteurs ; pas de protection magique |
