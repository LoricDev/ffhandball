---
name: Compétitions, phases et poules
description: Design de la 3ème entité du pipeline ffhandball — scraping des compétitions (3 niveaux), phases et poules depuis ffhandball.fr
type: spec
date: 2026-05-27
---

# Compétitions, phases et poules

## Contexte

Les deux premières entités du pipeline sont en place :
- `clubs` (passe 1 + passe 2 enrichie via fiches détail monclub.ffhandball.fr)
- `salles` (déduites des fiches détail club)

Cette spec couvre la 3ème entité : **les compétitions de handball**, leurs **phases** (subdivisions logiques) et leurs **poules**. C'est la dernière "brique structurelle" du pipeline avant les entités d'activité (équipes/engagements/matchs/classements).

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Alimenter `core.competitions` aux 3 niveaux (national, régional, départemental) à partir de `ffhandball.fr/competitions/`
- Modéliser fidèlement la couche **phase** (intermédiaire entre compétition et poule) via une nouvelle table `core.phases`
- Alimenter `core.poules` (sous-divisions de phases), avec FK vers `core.phases` (et non plus vers `core.competitions` comme dans le schéma initial vide)
- Préserver l'idempotence, la traçabilité et le pattern raw/core établi
- Permettre des ré-exécutions partielles (`--level=national` pour un test rapide, `--limit=N` pour dev)

## Non-objectifs

- Pas de scraping des matchs, classements ou statistiques (entités ultérieures du pipeline)
- Pas de scraping de `monclub.ffhandball.fr` dans cette feature (les compétitions vivent sur `ffhandball.fr`)
- Pas de table `core.structures` (ligues/comités d'organisation) — on stocke juste `ext_structure_id` en texte ; si besoin d'enrichir avec le nom de la structure, ce sera une feature séparée
- Pas d'extraction de `journees` ni `equipe_options` depuis les pages détail (matchs et engagements viendront avec leurs propres entités)
- Pas d'inférence de `categorie_age` (sera `NULL` initialement ; le champ existe déjà dans `core.competitions` mais doit devenir `nullable`)

## Architecture

```
ffhandball.fr (3 niveaux, smartfire-components)
        │
        ├── /competitions/saison-<S>-<ext>/national/        ──┐
        ├── /competitions/saison-<S>-<ext>/regional/        ──┼── liste des compétitions
        │    └── /regional/{ligue_slug}/                      │   (composant
        ├── /competitions/saison-<S>-<ext>/departemental/   ──┤   `competitions---competition-main-menu`)
        │    └── /departemental/{comite_slug}/                │
        ▼                                                     │
        parseCompetitionList(html, niveau)                    │
              + parseStructures(html)                         │
              → RawCompetitionPayload[]                       │
              → insertRaw(raw.competitions)                   │
                                                              ▼
        Pour chaque compétition insérée :
        ▼
        /competitions/.../<libelle_slug>-<ext_competition_id>/  (fiche détail)
        ▼
        parseCompetitionDetail(html, sourceUrl, ext_competition_id)
              → { phases: RawPhasePayload[], poules: RawPoulePayload[] }
              → insertRaw(raw.phases)
              → insertRaw(raw.poules)

        Puis ETL en 3 étapes (ordre obligatoire) :
        ▼
        competitions.etl → core.competitions
        phases.etl       → core.phases       (résout competition_id via ext_competition_id)
        poules.etl       → core.poules       (résout phase_id via ext_phase_id)
```

**Une seule commande CLI** `npm run scrape -- --entity=competitions` orchestre les 2 passes (liste + détail), pattern identique à `--entity=club-details`. Les 3 ETL se lancent ensuite séparément, dans l'ordre.

## Composants

### Nouveaux fichiers

- `src/scrapers/ffhandball/competition-list.scraper.ts`
  - `parseCompetitionList(html, niveau, sourceUrl) → RawCompetitionPayload[]`
  - `parseStructures(html) → StructureMeta[]` (ligues/comités, pour itérer en régional/dép)
- `src/scrapers/ffhandball/competition-detail.scraper.ts`
  - `parseCompetitionDetail(html, sourceUrl, ext_competition_id) → { phases, poules } | null`
- `src/schemas/competition.schema.ts` — schéma Zod du payload `raw.competitions`
- `src/schemas/phase.schema.ts` — schéma Zod du payload `raw.phases`
- `src/schemas/poule.schema.ts` — schéma Zod du payload `raw.poules`
- `src/etl/competitions.etl.ts` — pipeline `raw.competitions → core.competitions`
- `src/etl/phases.etl.ts` — pipeline `raw.phases → core.phases`
- `src/etl/poules.etl.ts` — pipeline `raw.poules → core.poules`
- `db/migrations/0008_competitions_phases_poules.sql` — création `raw.phases` + `raw.poules` + `core.phases` + recréation `core.poules` + enrichissements `core.competitions`
- `tests/fixtures/ffhandball-competitions-national.html` (et 4-5 autres fixtures, voir Tests)
- `tests/scrapers/competition-list.scraper.test.ts`
- `tests/scrapers/competition-detail.scraper.test.ts`
- `tests/etl/competitions.etl.test.ts`
- `tests/etl/phases.etl.test.ts`
- `tests/etl/poules.etl.test.ts`
- `tests/integration/competitions-end-to-end.test.ts`

### Fichiers modifiés

- `src/cli/scrape.ts` — accepte `--entity=competitions [--level=national|regional|departemental] [--limit=N]`
- `src/cli/etl.ts` — accepte `--entity={competitions,phases,poules}`
- `docs/runbook.md` — nouvelle section "Scrape compétitions / phases / poules"

## Découverte : structure HTML cible

Toutes les données vivent dans `<smartfire-component attributes='{JSON}'>` (HTML-escaped via `&quot;`), même pattern que monclub.ffhandball.fr.

### Page liste `/national/`

Composant cible : `smartfire-component[name='competitions---competition-main-menu']`.

```json
{
  "ext_saison_id": "21",
  "url_competition_type": "national",
  "available_types": ["NATIONAL","REGIONAL","DEPARTEMENTAL","COUPE_DE_FRANCE","INTER_LIGUES","INTER_COMITES"],
  "structures": [],
  "competitions": [
    {
      "id": "26692",
      "ext_competitionId": "28227",
      "saisonId": "21",
      "structureId": "1",
      "code": "001",
      "libelle": "LIGUE BUTAGAZ ENERGIE 2025-26",
      "genre": "FEMININ",
      "type": "NATIONAL",
      "logo": "D1F",
      "dateDernierUpdateEnfants": "2026-05-27 07:12:49.000",
      "afficherStatsJoueurs": "1"
    }
  ]
}
```

### Page liste `/regional/` (et `/departemental/`)

Même composant, mais `competitions: []` au premier niveau ; il faut itérer sur `structures[]`.

```json
{
  "structures": [
    {
      "id": "4",
      "ext_structureId": "4",
      "libelle": "LIGUE AUVERGNE-RHONE-ALPES",
      "code": "5100000",
      "sigle": "AURAHB",
      "type": "LIG"
    }
  ]
}
```

Le slug URL d'une structure n'est pas exposé directement. **Hypothèse à valider en T1** : `/regional/{slug(libelle)}-{ext_structureId}/` (slug-dash-id, pattern observé pour les compétitions elles-mêmes).

### Page détail compétition

Composant cible : `smartfire-component[name='competitions---poule-selector']`.

```json
{
  "phases": [
    {
      "id": "69357",
      "ext_phaseId": "96749",
      "competitionId": "26692",
      "libelle": "LIGUE BUTAGAZ ENERGIE",
      "classement": "1"
    }
  ],
  "poules": [
    {
      "id": "193158",
      "ext_pouleId": "168256",
      "phaseId": "69357",       // ← référence l'id interne de phase, pas ext_phaseId
      "libelle": "POULE UNIQUE",
      "journees": "[...]"        // ignoré dans cette feature
    }
  ]
}
```

⚠️ Les poules référencent `phaseId` = id interne de phase, pas `ext_phaseId`. Le scraper doit faire le mapping `phase.id → phase.ext_phaseId` pour enrichir chaque payload poule avec le bon `ext_phase_id`.

## Schémas de données

### `raw.competitions.payload`

```ts
export const rawCompetitionPayloadSchema = z.object({
  ext_competition_id: z.string().min(1),                       // "28227"
  nom: z.string().min(1),                                      // libelle
  niveau: z.enum(["national","regional","departemental"]),     // mapping depuis "type"
  sexe: z.enum(["M","F","mixte"]).optional(),                  // mapping depuis "genre"
  code: z.string().optional(),                                 // "001"
  ext_structure_id: z.string().optional(),                     // "1" / "4" ...
  detail_url: z.string().url(),                                // page détail dérivée
  source_url: z.string().url(),                                // page liste d'origine
});
```

**Mappings depuis la source :**
- `type: "NATIONAL"` → `niveau: "national"`
- `type: "REGIONAL"` → `niveau: "regional"`
- `type: "DEPARTEMENTAL"` → `niveau: "departemental"`
- `type: "COUPE_DE_FRANCE" | "INTER_LIGUES" | "INTER_COMITES"` → mappés sur `"national"` (compétitions nationales par nature)
- `genre: "FEMININ"` → `sexe: "F"`
- `genre: "MASCULIN"` → `sexe: "M"`
- `genre: "MIXTE"` → `sexe: "mixte"`
- `genre` absent ou inconnu → `sexe: undefined`

**Construction de `detail_url`** : `${BASE}/competitions/saison-${saison_slug}-${ext_saison_id}/${niveau_url}/${slug(libelle)}-${ext_competition_id}/` où `niveau_url ∈ {national, regional, departemental}` et `slug()` est la même fonction de slugification que pour les salles (NFD + diacritics strip + dash-only).

**natural_key competitions** : `ext_competition_id`.

### `raw.phases.payload`

```ts
export const rawPhasePayloadSchema = z.object({
  ext_phase_id: z.string().min(1),                  // "96749"
  ext_competition_id: z.string().min(1),            // FK natural key résolue en ETL
  nom: z.string().min(1),                           // libelle
  source_url: z.string().url(),                     // page détail compétition
});
```

**natural_key phases** : `ext_phase_id`.

### `raw.poules.payload`

```ts
export const rawPoulePayloadSchema = z.object({
  ext_poule_id: z.string().min(1),                  // "168256"
  ext_phase_id: z.string().min(1),                  // FK natural key résolue en ETL
  nom: z.string().min(1),                           // libelle ("POULE UNIQUE")
  source_url: z.string().url(),
});
```

**natural_key poules** : `ext_poule_id`.

## Schéma DB (migration `0008`)

### Raw tables

```sql
SELECT raw._create_capture_table('phases');
SELECT raw._create_capture_table('poules');
-- raw.competitions existe déjà (migration 0001)
```

### Core schema

```sql
-- 1. Enrichir core.competitions (champs déjà présents : id, id_ffhb UNIQUE, nom,
--    niveau, sexe, categorie_age, saison_code, timestamps)
ALTER TABLE core.competitions ALTER COLUMN sexe DROP NOT NULL;
ALTER TABLE core.competitions ALTER COLUMN categorie_age DROP NOT NULL;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS ext_structure_id TEXT;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS detail_url TEXT;

-- 2. Drop existing core.poules (jamais peuplée, FK vers competitions sera remplacée par FK vers phases)
DROP TABLE IF EXISTS core.poules CASCADE;

-- 3. Create core.phases
CREATE TABLE core.phases (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,                       -- ext_phase_id
  competition_id  bigint NOT NULL REFERENCES core.competitions(id),
  nom             text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_phases_id_ffhb_saison UNIQUE (id_ffhb, saison_code)
);
CREATE INDEX idx_phases_competition ON core.phases (competition_id);

-- 4. Recreate core.poules (FK vers phases, plus competitions)
CREATE TABLE core.poules (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,                       -- ext_poule_id
  phase_id        bigint NOT NULL REFERENCES core.phases(id),
  nom             text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_poules_id_ffhb_saison UNIQUE (id_ffhb, saison_code)
);
CREATE INDEX idx_poules_phase ON core.poules (phase_id);
```

⚠️ `core.engagements` référence `core.poules(id)`. Le `DROP TABLE ... CASCADE` cassera la FK depuis `core.engagements`. Comme `core.poules` et `core.engagements` sont vides à ce stade (jamais peuplées), c'est acceptable. La migration `0008` recrée la FK : `ALTER TABLE core.engagements ADD CONSTRAINT engagements_poule_id_fkey FOREIGN KEY (poule_id) REFERENCES core.poules(id);` (à inclure explicitement après recréation de `core.poules`).

## Logique scraper

### `parseCompetitionList`

1. Charger HTML via cheerio, cibler `smartfire-component[name='competitions---competition-main-menu']`.
2. `JSON.parse(el.attr('attributes'))` ; en cas d'échec → `[]`.
3. Itérer sur `data.competitions[]` ; pour chaque entrée :
   - Construire `RawCompetitionPayload` via les mappings ci-dessus
   - `detail_url` = construction déterministe depuis `libelle + ext_competitionId + niveau + ext_saison_id`
   - Zod validate ; rejets loggués (cas dégradé, voir plus bas)
4. Retourner le tableau dédoublonné par `ext_competition_id`.

### `parseStructures`

1. Même composant, mais retourner `data.structures[]` avec normalisation : `{ ext_structure_id, libelle, sigle, code, type }`.
2. Calcul du slug à l'usage : `slug(libelle)-${ext_structure_id}` (fonction de slug identique à celle des salles).
3. Retour vide si `structures` absent.

### `parseCompetitionDetail`

1. Cibler `smartfire-component[name='competitions---poule-selector']` ; absent → `null`.
2. `JSON.parse(el.attr('attributes'))` ; échec → `null`.
3. Construire un index `{ phase.id → phase.ext_phaseId }` depuis `data.phases[]`.
4. Itérer sur `data.phases[]` → `RawPhasePayload` (enrichi avec `ext_competition_id` du paramètre).
5. Itérer sur `data.poules[]` → `RawPoulePayload` (enrichi avec `ext_phase_id = index[poule.phaseId]`). Si le mapping échoue (phase orpheline), skip la poule + log warning.
6. Retourner `{ phases, poules }` (l'un peut être vide).

## Logique CLI scrape

```ts
async function scrapeCompetitions(saison, opts: { level?, limit? }) {
  // 1. Fetch /competitions/ → lit `ext_saison_id` depuis le composant
  //    `competitions---saison-selector` (filtre sur saison_code == --saison).
  //    Toutes les URLs ultérieures sont construites avec ce ext_saison_id.

  // 2. Pour chaque niveau dans [national, regional, departemental] (ou filtré par --level) :
  //    a. Fetch /competitions/saison-...-N/<niveau>/
  //    b. Si national : parseCompetitionList(html, "national") → insertRaw competitions
  //    c. Si regional/departemental :
  //       - parseStructures(html) → liste de ligues/comités
  //       - Pour chaque structure : fetch /<niveau>/<slug(libelle)>-<ext_structure_id>/
  //         → parseCompetitionList → insertRaw competitions
  //         → respect rate-limit ≥1.5s
  //       - Si 404 sur une structure → warn + continue

  // 3. SELECT les compétitions juste insérées (avec leur detail_url + ext_competition_id)
  //    Optionnel : appliquer --limit=N

  // 4. Pour chaque compétition :
  //    a. Fetch detail_url (rate-limit)
  //    b. parseCompetitionDetail(html, detail_url, ext_competition_id)
  //    c. insertRaw phases + poules (insertions multiples possibles par compétition)

  // 5. Mark scrape_run success / partial / failed
}
```

Réutilise les helpers existants : `runScrape()` (gestion `scrape_runs`), `fetchHtml()` (rate-limit + User-Agent), `insertRaw()`.

## Logique ETL

Les 3 ETL suivent le pattern UPSERT idempotent établi (mêmes utilitaires que `clubs.etl.ts` / `salles.etl.ts`).

### `runCompetitionsEtl(saison)`

```sql
SELECT DISTINCT ON (natural_key) natural_key, payload
FROM raw.competitions
WHERE saison = $1
ORDER BY natural_key, scraped_at DESC;
```

Pour chaque ligne :
- Zod validate ; rejet → `core.etl_rejets`
- `niveau`, `sexe`, `code`, `ext_structure_id`, `detail_url` mappés directement
- `nom` = `payload.nom` (déjà extrait du `libelle` source ; pas de normalisation française façon `titleCaseFr` car les libellés sont souvent des sigles)
- UPSERT `core.competitions` ON CONFLICT `(id_ffhb)` (UNIQUE existant), COALESCE pour les champs optionnels, CASE `updated_at` conditionnel
- `last_seen_at = NOW()` à chaque run

### `runPhasesEtl(saison)`

Idem, depuis `raw.phases`. Pour chaque ligne :
- Résolution FK : `SELECT id FROM core.competitions WHERE id_ffhb = $1 AND saison_code = $2`
- FK non résolue → `core.etl_warnings` ; skip la ligne
- UPSERT `core.phases` ON CONFLICT `(id_ffhb, saison_code)`

### `runPoulesEtl(saison)`

Idem, depuis `raw.poules`. Pour chaque ligne :
- Résolution FK : `SELECT id FROM core.phases WHERE id_ffhb = $1 AND saison_code = $2`
- FK non résolue → `core.etl_warnings` ; skip la ligne
- UPSERT `core.poules` ON CONFLICT `(id_ffhb, saison_code)`

**Ordre obligatoire** documenté dans le runbook : `competitions` → `phases` → `poules`. Un re-run de `phases` après `competitions` résout les FKs manquantes (les warnings antérieurs restent en base mais l'état final est correct, même pattern que clubs/salles).

## CLI

```bash
# Scrape : un seul niveau (test dev)
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national

# Limiter le nombre de détails fetchés (mais tous les niveaux pour les listes)
npm run scrape -- --entity=competitions --saison=2025-2026 --limit=10

# Run complet
npm run scrape -- --entity=competitions --saison=2025-2026

# ETL — ordre obligatoire
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
```

## Tests

### Fixtures à capturer (T1)

```
tests/fixtures/
  ffhandball-competitions-national.html            # 20 compétitions nationales
  ffhandball-competitions-regional.html            # 19 structures, competitions[]=[]
  ffhandball-competitions-departemental.html       # ~100 structures
  ffhandball-competitions-ligue-X.html             # /regional/{slug}/ avec compétitions (validation pattern URL)
  ffhandball-competition-detail-mono-poule.html    # 1 phase + 1 poule (ex: LIGUE BUTAGAZ)
  ffhandball-competition-detail-multi-poules.html  # N poules sur M phases (compet régionale typique)
```

T1 inclut la validation du pattern URL per-structure : si `/regional/{slug(libelle)}-{ext_structureId}/` ne marche pas, ajuster en lisant des liens HTML directement plutôt qu'en reconstruisant.

### Unitaires scrapers

- `parseCompetitionList` :
  - Extrait 20 compétitions du fixture national ; types/champs corrects
  - Mappings `genre → sexe` et `type → niveau` validés sur cas réels
  - `parseStructures` : vide pour national, 19 entries pour régional, ~100 pour départemental
  - HTML sans smartfire-component → `[]`
  - `attributes` JSON malformé → `[]`
- `parseCompetitionDetail` :
  - Cas mono-poule : 1 phase + 1 poule ; `ext_phase_id` propagé sur la poule
  - Cas multi-poules : chaque poule reçoit l'`ext_phase_id` de sa phase d'appartenance
  - `phaseId` orphelin sur une poule → poule skippée (warning)
  - Pas de poule-selector → `null`
  - JSON malformé → `null`

### Unitaires ETL

- `competitions.etl` : nominal, rejet Zod, idempotence (2 runs successifs → mêmes lignes)
- `phases.etl` : nominal, FK competition non résolue → warning + skip, idempotence
- `poules.etl` : nominal, FK phase non résolue → warning + skip, idempotence

### Intégration end-to-end

`tests/integration/competitions-end-to-end.test.ts` :
- Setup : insert saison + scrape_run, parser sur fixtures, `insertRaw` competitions/phases/poules
- Run les 3 ETL en séquence (`competitions`, `phases`, `poules`)
- Assertions : counts attendus, présence d'une compétition connue (LIGUE BUTAGAZ), résolution FK correcte sur sa phase et sa poule
- Idempotence : re-run complet → mêmes counts, pas de doublons

## Cas dégradés

| Cas | Comportement |
|---|---|
| Saison inconnue (404 sur `/competitions/`) | Scrape run `failed`, erreur explicite |
| Page liste niveau (`/national/`) sans smartfire-component | Scrape run `partial`, log warning, continue les autres niveaux |
| `competitions[]` vide sur une structure régionale/dép | OK (structure sans compétitions cette saison), log info |
| Page per-structure 404 | Warning, continue les autres structures, scrape run `partial` à la fin |
| Page détail compétition sans `poule-selector` | Compétition gardée dans `raw.competitions`, pas de phases/poules associées (warning) |
| `phaseId` d'une poule absent de `phases[]` | Skip cette poule + log warning |
| `ext_phase_id` / `ext_poule_id` / `ext_competition_id` manquant | Zod reject → `core.etl_rejets` |
| ETL `phases` lancé avant `competitions` | Warnings FK pour toutes les phases ; re-run après `competitions` les résout |
| Re-scrape complet | Nouvelles lignes raw (append-only), ETL prend `DISTINCT ON (natural_key)` la plus récente, UPSERT en core, pas de doublons |

## Volumétrie attendue

- **National** : ~20 compétitions, ~20 détails à fetcher
- **Régional** : 19 ligues × ~5-10 compétitions = ~100-200 compétitions
- **Départemental** : ~100 comités × ~3-5 compétitions = ~300-500 compétitions
- **Total** : ~500-700 compétitions, autant de pages détail
- **Phases** : ~600-900 (souvent 1 par compétition, parfois 2-3)
- **Poules** : ~1500-3000 (1 à 8 poules par phase selon le niveau)
- **Temps total** : ~25-35 min à 1.5s/req (à exécuter en nocturne pour le run complet)

## Pipeline state après cette feature

```
✅ clubs (listing + détail enrichi)
✅ salles (déduites des fiches détail club)
✅ competitions + phases + poules    ← cette feature
⏭ equipes + engagements              ← prochaine entité
⏭ joueurs + licences
⏭ arbitres
⏭ matchs
⏭ match_compositions
⏭ classements
```
