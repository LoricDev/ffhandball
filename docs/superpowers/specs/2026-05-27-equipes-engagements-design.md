---
name: Équipes et engagements
description: Design de la 4ème entité du pipeline ffhandball — équipes engagées en compétition et leur lien many-to-many vers les poules
type: spec
date: 2026-05-27
---

# Équipes et engagements

## Contexte

Les 3 premières entités structurelles du pipeline sont en place : `clubs` + `salles`, `competitions` + `phases` + `poules`. Cette spec couvre la 4ème entité : les **équipes** engagées en compétition et leur lien many-to-many avec les **poules** (table `engagements`).

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Alimenter `core.equipes` avec toutes les équipes engagées en compétition (3 niveaux) à partir des pages détail compétition de `ffhandball.fr`
- Alimenter `core.engagements` (équipe × poule, PK composite)
- Préserver l'idempotence et la traçabilité
- Permettre la résolution future de la FK `equipes.club_id` (mapping `ext_structure_id` → `clubs.id_ffhb`) sans rework du schéma

## Non-objectifs

- Pas de résolution de la FK `equipes.club_id` dans cette feature — `club_id` reste NULL initialement (warning ETL par équipe) ; une feature dédiée "résolution clubs" fera le matching plus tard (par nom/ville, ou via une page Rosetta-stone si elle est identifiée)
- Pas d'inférence de `sexe` ni `categorie_age` côté équipe — la source ne les expose pas explicitement ; ils restent NULL et pourront être hérités de `core.competitions` plus tard si besoin
- Pas de scraping de fiches détail équipe (n'existent pas côté ffhandball.fr / monclub.ffhandball.fr d'après l'exploration)
- Pas de fetch poule-par-poule en cas de fallback `equipe_options` (couverture dégradée acceptée pour ce cas rare)

## Architecture

```
ffhandball.fr — pages détail compétition (déjà scrapées en feature précédente, mais re-fetch nécessaire car HTML brut pas stocké)
        │
        ▼
parseCompetitionDetail() étendu :
  - phases[] + poules[]                          (déjà OK)
  - NOUVEAU : equipes[] depuis calendar-button   (source principale)
  - NOUVEAU : fallback equipe_options[] depuis poule-selector si calendar-button absent
  - équipes enrichies avec leur ext_poule_id (via index poule.id → poule.ext_pouleId)
  → { phases, poules, equipes, engagements }
        │
        ▼
raw.equipes        +     raw.engagements (nouveau)
        │
        ▼
ETL en 2 étapes (après competitions/phases/poules) :
  equipes.etl      → core.equipes      (club_id = NULL + warning)
  engagements.etl  → core.engagements  (FK equipe + FK poule résolues)
```

**Ordre ETL complet après cette feature** : `competitions → phases → poules → equipes → engagements`.

Une seule commande scrape : `npm run scrape -- --entity=competitions` (étendue pour aussi insérer dans `raw.equipes` + `raw.engagements`). Re-run complet nécessaire pour récupérer les équipes (~30 min nocturne).

## Composants

### Nouveaux fichiers

- `src/schemas/equipe.schema.ts` — schéma Zod `raw.equipes`
- `src/schemas/engagement.schema.ts` — schéma Zod `raw.engagements`
- `src/etl/equipes.etl.ts` — pipeline `raw.equipes → core.equipes`
- `src/etl/engagements.etl.ts` — pipeline `raw.engagements → core.engagements`
- `db/migrations/0009_equipes_engagements.sql` — `raw.engagements` + alter `core.equipes` (nullable club_id/sexe/categorie_age, add id_ffhb/ext_structure_id/logo, rename nom_equipe→nom, new UNIQUE)
- `tests/schemas/equipe.schema.test.ts`
- `tests/schemas/engagement.schema.test.ts`
- `tests/etl/equipes.etl.test.ts`
- `tests/etl/engagements.etl.test.ts`
- `tests/integration/equipes-end-to-end.test.ts`

### Fichiers modifiés

- `src/scrapers/ffhandball/competition-detail.scraper.ts` — `parseCompetitionDetail` retourne désormais `{ phases, poules, equipes, engagements }`
- `tests/scrapers/competition-detail.scraper.test.ts` — ajout de tests sur équipes/engagements + fallback
- `src/cli/scrape.ts` — insertion dans `raw.equipes` + `raw.engagements` dans le handler `scrapeCompetitions`
- `src/cli/etl.ts` — accepte `--entity={equipes,engagements}`
- `docs/runbook.md` — sous-section "Équipes et engagements" dans la section compétitions

## Source de données

### Composant principal : `competitions---calendar-button`

URL : pages détail compétition déjà fetchées (`/competitions/saison-.../<niveau>/<libelle>-<ext_competition_id>/`).

```json
{
  "equipes": [
    {
      "id": "1237218",              // PK Smartfire interne (ignoré)
      "ext_equipeId": "1949474",    // ← natural_key équipe
      "pouleId": "193158",          // PK interne de la poule (à mapper via index)
      "structureId": "532",         // PK Smartfire club interne (ignoré)
      "ext_structureId": "1720",    // ← ID club Smartfire (futur match FK club)
      "libelle": "BREST BRETAGNE HANDBALL",
      "logo": "2023-06-13-...jpg",
      "logoActif": "1"
    }
  ]
}
```

**Avantages** : toutes les équipes de toutes les poules de la compétition en une seule réponse, avec `ext_structureId` et `logo`.

### Fallback : `competitions---poule-selector` champ `equipe_options[]`

Même structure mais 6 champs (pas de `ext_structureId`, pas de `logo`), et **ne couvre que la poule actuellement sélectionnée**.

```json
{
  "equipe_options": [
    {
      "id": "1237218",
      "ext_equipeId": "1949474",
      "pouleId": "193158",
      "structureId": "532",
      "libelle": "BREST BRETAGNE HANDBALL",
      "logoActif": "1"
    }
  ]
}
```

**Politique** : utiliser `calendar-button.equipes` en priorité ; si absent, fallback sur `poule-selector.equipe_options` avec un warning scraper. Sur une compétition multi-poules sans `calendar-button` (cas rare/hypothétique), on ne récupère que les équipes de la poule par défaut — la couverture sera incomplète mais cohérente.

## Schémas de données

### `raw.equipes.payload`

```ts
export const rawEquipePayloadSchema = z.object({
  ext_equipe_id: z.string().min(1),             // "1949474"
  nom: z.string().min(1),                        // libelle ("BREST BRETAGNE HANDBALL")
  ext_structure_id: z.string().optional(),      // "1720" — pour future résolution FK club
  logo: z.string().optional(),                  // nom du fichier
  source_url: z.string().url(),                 // page détail compétition
});
export type RawEquipePayload = z.infer<typeof rawEquipePayloadSchema>;
```

**natural_key** : `ext_equipe_id`.

### `raw.engagements.payload`

```ts
export const rawEngagementPayloadSchema = z.object({
  ext_equipe_id: z.string().min(1),
  ext_poule_id: z.string().min(1),              // déjà résolu via index dans le scraper
  source_url: z.string().url(),
});
export type RawEngagementPayload = z.infer<typeof rawEngagementPayloadSchema>;
```

**natural_key (composite serialisé)** : `${ext_equipe_id}-${ext_poule_id}`.

## Migration `0009_equipes_engagements.sql`

```sql
-- 1. Raw table (engagements n'existe pas, equipes existe déjà depuis migration 0001)
SELECT raw._create_capture_table('engagements');

-- 2. Alter core.equipes
-- État actuel (migration 0003) :
--   (id, club_id NOT NULL FK, nom_equipe, sexe NOT NULL, categorie_age NOT NULL,
--    saison_code FK, timestamps, UNIQUE (club_id, nom_equipe, saison_code))

ALTER TABLE core.equipes DROP CONSTRAINT IF EXISTS uq_equipes_club_nom_saison;
ALTER TABLE core.equipes ALTER COLUMN club_id DROP NOT NULL;
ALTER TABLE core.equipes ALTER COLUMN sexe DROP NOT NULL;
ALTER TABLE core.equipes ALTER COLUMN categorie_age DROP NOT NULL;
ALTER TABLE core.equipes RENAME COLUMN nom_equipe TO nom;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS ext_structure_id TEXT;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS logo TEXT;

ALTER TABLE core.equipes ADD CONSTRAINT uq_equipes_id_ffhb_saison
  UNIQUE (id_ffhb, saison_code);

CREATE INDEX IF NOT EXISTS idx_equipes_club          ON core.equipes (club_id);
CREATE INDEX IF NOT EXISTS idx_equipes_ext_structure ON core.equipes (ext_structure_id);
CREATE INDEX IF NOT EXISTS idx_equipes_nom_trgm      ON core.equipes USING gin (nom gin_trgm_ops);
```

⚠️ `core.equipes` est vide à ce stade (jamais peuplée). Si elle était non-vide dans le futur, les `DROP NOT NULL` resteraient OK (pas de re-write), mais le rename `nom_equipe → nom` reste safe.

`core.engagements` n'est PAS modifiée — structure existante `(equipe_id FK, poule_id FK, PK (equipe_id, poule_id))` est suffisante. La FK `poule_id` a été recréée en migration 0008.

## Logique scraper

### Extension de `parseCompetitionDetail`

```ts
export interface CompetitionDetailResult {
  phases: RawPhasePayload[];
  poules: RawPoulePayload[];
  equipes: RawEquipePayload[];          // ← nouveau
  engagements: RawEngagementPayload[];  // ← nouveau
}

export function parseCompetitionDetail(html, sourceUrl, extCompetitionId) {
  const $ = cheerio.load(html);

  // 1. poule-selector (logique existante) → phases + poules + index pouleId(interne) → ext_pouleId
  const pouleSelectorData = loadAttributes($, "competitions---poule-selector");
  if (!pouleSelectorData) return null;
  // ... extract phases[], poules[], build pouleIdToExtPouleId map

  // 2. calendar-button (nouveau) → equipes + engagements
  const calendarData = loadAttributes($, "competitions---calendar-button");
  let rawTeams: SourceTeam[] = [];
  let usedFallback = false;
  if (calendarData?.equipes?.length > 0) {
    rawTeams = calendarData.equipes;
  } else if (pouleSelectorData.equipe_options?.length > 0) {
    rawTeams = pouleSelectorData.equipe_options;
    usedFallback = true;
    // log warning : "calendar-button absent, fallback equipe_options"
  }

  const equipes: RawEquipePayload[] = [];
  const engagements: RawEngagementPayload[] = [];
  const seenEquipeIds = new Set<string>();
  const seenEngagements = new Set<string>();

  for (const t of rawTeams) {
    const extEquipeId = t.ext_equipeId;
    const nom = t.libelle;
    const internalPouleId = t.pouleId;
    if (!extEquipeId || !nom || !internalPouleId) continue;

    const extPouleId = pouleIdToExtPouleId.get(internalPouleId);
    if (!extPouleId) continue; // orpheline → skip

    if (!seenEquipeIds.has(extEquipeId)) {
      seenEquipeIds.add(extEquipeId);
      const parsed = rawEquipePayloadSchema.safeParse({
        ext_equipe_id: extEquipeId,
        nom,
        ext_structure_id: t.ext_structureId,
        logo: t.logo,
        source_url: sourceUrl,
      });
      if (parsed.success) equipes.push(parsed.data);
    }

    const engKey = `${extEquipeId}-${extPouleId}`;
    if (!seenEngagements.has(engKey)) {
      seenEngagements.add(engKey);
      const parsed = rawEngagementPayloadSchema.safeParse({
        ext_equipe_id: extEquipeId,
        ext_poule_id: extPouleId,
        source_url: sourceUrl,
      });
      if (parsed.success) engagements.push(parsed.data);
    }
  }

  return { phases, poules, equipes, engagements };
}
```

**Cas dégradés gérés** :
- `calendar-button` absent → fallback `equipe_options` + log warning
- `calendar-button` ET `equipe_options` absents → `equipes: []`, `engagements: []` mais retour non-null
- Équipe dont `pouleId` ne match aucune poule connue → skip silencieux
- Champ requis manquant → Zod reject + skip

## Logique ETL

### `runEquipesEtl(saison)`

```sql
SELECT DISTINCT ON (natural_key) natural_key, payload
FROM raw.equipes
WHERE saison = $1
ORDER BY natural_key, scraped_at DESC;
```

Pour chaque ligne :
- Zod validate → reject → `core.etl_rejets`
- **Pas de résolution FK club_id** — toujours NULL pour l'instant
- Insert systématique d'un warning `core.etl_warnings` : `"club_id non résolu (ext_structure_id=X)"` (un par équipe, par run — cohérent avec les autres ETLs où les warnings sont per-run)
- UPSERT `core.equipes` par `(id_ffhb, saison_code)` :
  - `nom`, `ext_structure_id`, `logo` mappés directement
  - `club_id`, `sexe`, `categorie_age` restent NULL
  - COALESCE sur les champs nullable, CASE updated_at conditionnel
  - `last_seen_at = NOW()` à chaque run

### `runEngagementsEtl(saison)`

```sql
SELECT DISTINCT ON (natural_key) natural_key, payload
FROM raw.engagements
WHERE saison = $1
ORDER BY natural_key, scraped_at DESC;
```

Pour chaque ligne :
- Zod validate → reject
- Résolution FK équipe : `SELECT id FROM core.equipes WHERE id_ffhb = $1 AND saison_code = $2` → warning + skip si NULL
- Résolution FK poule : `SELECT id FROM core.poules WHERE id_ffhb = $1 AND saison_code = $2` → warning + skip si NULL
- `INSERT INTO core.engagements (equipe_id, poule_id) VALUES ($1,$2) ON CONFLICT (equipe_id, poule_id) DO NOTHING`
- Idempotence assurée par le PK composite

## CLI

```bash
# Scrape (re-run nécessaire pour récupérer les équipes)
npm run scrape -- --entity=competitions --saison=2025-2026

# ETL — ordre complet, 5 étapes
npm run etl -- --entity=competitions  --saison=2025-2026
npm run etl -- --entity=phases        --saison=2025-2026
npm run etl -- --entity=poules        --saison=2025-2026
npm run etl -- --entity=equipes       --saison=2025-2026  # ← nouveau
npm run etl -- --entity=engagements   --saison=2025-2026  # ← nouveau
```

`--entity=equipes` lancé avant que `competitions/phases/poules` ne soient peuplés fonctionne mais génère des warnings inutiles (équipes orphelines de poules) lors du `engagements.etl` qui suit.

## Tests

### Unitaires schémas

`tests/schemas/equipe.schema.test.ts` (3 tests) et `engagement.schema.test.ts` (2 tests) — payloads valides, rejets sur champs requis manquants.

### Scraper étendu

Ajout dans `tests/scrapers/competition-detail.scraper.test.ts` :
- "extracts 14 équipes + 14 engagements from mono-poule LBE (via calendar-button)" — chaque équipe a `ext_structure_id` + `logo`
- "extracts 96 équipes + 96 engagements from multi-poules N3M, mapped to 8 distinct ext_poule_id"
- "falls back to equipe_options when calendar-button is absent" — HTML synthétique, équipes extraites sans `ext_structure_id`/`logo`
- "returns empty equipes/engagements when both sources absent"
- "skips équipe whose pouleId is orphan"

### ETL equipes

`tests/etl/equipes.etl.test.ts` (4 tests) :
- Insert valide → `club_id IS NULL`, warning émis, `ext_structure_id`/`logo` populés
- Rejet Zod → `core.etl_rejets`
- Idempotence : 2 runs → 1 ligne, 2 warnings (per-run)
- Update : changement de `nom` ou `logo` → `updated_at` bouge

### ETL engagements

`tests/etl/engagements.etl.test.ts` (4 tests) :
- Insert valide avec FK equipe + FK poule résolues
- FK equipe non résolue → warning + skip
- FK poule non résolue → warning + skip
- Idempotence via `ON CONFLICT DO NOTHING` sur PK composite

### Intégration end-to-end

`tests/integration/equipes-end-to-end.test.ts` (2 tests) :
- Setup : seed competitions/phases/poules en core, parser sur fixture mono-poule, insertRaw equipes + engagements
- Run equipes ETL → 14 lignes, 14 warnings (club_id NULL)
- Run engagements ETL → 14 lignes, 0 warning
- Re-run complet → idempotent (mêmes counts, warnings ajoutés mais lignes inchangées)

## Cas dégradés

| Cas | Comportement |
|---|---|
| `calendar-button` absent | Fallback `equipe_options` du poule-selector + warning scraper. Couverture dégradée sur multi-poules |
| `calendar-button` ET `equipe_options` absents | Aucune équipe extraite ; phases/poules OK ; warning scraper |
| Équipe avec `pouleId` orphelin (pas dans phases/poules de la compétition) | Skip silencieux côté scraper |
| `ext_equipe_id` ou `pouleId` manquant | Skip ligne, log info |
| Équipe valide mais ETL engagements lancé avant equipes | Warning + skip pour chaque engagement (FK equipe NULL) ; re-run engagements après equipes résout |
| Équipe avec `ext_structure_id` absent | Insertion en core sans, warning ETL (club_id NULL anyway) |
| Re-scrape complet | Append-only raw + DISTINCT ON la plus récente → idempotent |
| Migration 0009 si `core.equipes` non-vide (régression future) | Les `DROP NOT NULL` et `ADD COLUMN` sont safe ; le rename `nom_equipe → nom` aussi. Pas d'action requise |

## Volumétrie attendue

- ~1 500-3 000 poules × 8-14 équipes/poule **=** ~15 000-40 000 lignes engagements
- ~5 000-10 000 équipes uniques (déduplication massive : un club a 5-15 équipes engagées par saison)
- Smoke test sur 3 compétitions T7 : ~30 équipes, ~30 engagements
- Run complet : durée scraping inchangée (mêmes URLs), durée ETL +~2-5 min

## Pipeline state après cette feature

```
✅ clubs (listing + détail enrichi)
✅ salles
✅ competitions + phases + poules
✅ equipes + engagements           ← cette feature
⏭ joueurs + licences               ← prochaine entité
⏭ arbitres
⏭ matchs
⏭ match_compositions
⏭ classements
```

## Future feature liée : résolution clubs

Un mapping `core.equipes.ext_structure_id → core.clubs.id` ne peut pas être construit depuis les sources actuelles (4 espaces d'identifiants disjoints). Une feature dédiée devra :
- Soit identifier une page exposant les deux IDs pour le même club
- Soit faire du fuzzy matching `equipes.nom` vs `clubs.nom (+ ville)` via pg_trgm (déjà installé)
- Soit utiliser les comptes licence par club pour confirmer les matchs

Cette feature est **hors scope** de la présente spec. Elle pourra être lancée à tout moment après cette feature sans modification de schéma (juste un `UPDATE core.equipes SET club_id = ...`).
