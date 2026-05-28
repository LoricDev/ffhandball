---
name: Classements par poule
description: Design de la 7ème entité du pipeline ffhandball — table de classement par poule (position, points, J/G/N/P, BP/BC/diff, forme récente)
type: spec
date: 2026-05-28
---

# Classements par poule

## Contexte

Les 6 premières entités du pipeline sont livrées (clubs/salles, competitions/phases/poules, equipes/engagements, matchs, arbitres/match_officiels). Cette spec couvre la 7ème : les **classements** par poule — snapshot des positions, points, statistiques aggrégées par équipe.

Source : composant `competitions---classement` sur `{detail_url}poule-{ext_poule_id}/classements/`.

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Alimenter `core.classements` avec un snapshot du classement par (poule, équipe) — PK composite déjà existante
- Capturer la **forme récente** (5 derniers résultats) via nouveau champ `dernieres_rencontres TEXT`
- Tracer l'`ext_classementId` officiel FFHB pour traçabilité future
- Disponibilité 3 niveaux confirmée par exploration (national + régional + départemental)
- Idempotence : un re-run met à jour points/positions et bouge `capture_date`

## Non-objectifs

- Pas d'historique des classements (snapshot = état actuel ; un re-run écrase la version précédente)
- Pas de gestion des forfaits/pénalités séparée (intégrée dans `points` côté source)
- Pas de classements par équipe agrégés cross-poule (vue à construire côté API future)
- Pas de classements de buteurs / statistiques individuelles (entité distincte `stats_joueurs`)

## Architecture

```
core.poules (lue depuis core, déjà peuplée)
        │
        ▼ Pour chaque poule :
        │
fetch {detail_url}poule-{ext_poule_id}/classements/
        │
        ▼
parseClassement(html, sourceUrl, extPouleId) :
  - Cible competitions---poule-selector → index equipe_options (id interne → ext_equipeId)
  - Cible competitions---classement → data.classements[]
  - Pour chaque ligne :
      * Résoudre ext_equipe_id via index
      * Garder uniquement si extPouleId match (anti-fuite)
      * Decode entités HTML dans equipe_libelle (utile pour fallback debugging)
  - Retour : RawClassementPayload[]
        │
        ▼
raw.classements (natural_key = ext_classement_id)
        │
        ▼
classements.etl → core.classements :
  - Résolution FK : poule_id, equipe_id (warning + skip si non résolu)
  - UPSERT par (poule_id, equipe_id) PK composite
  - capture_date = now() à chaque run
  - id_ffhb stocké (= ext_classement_id)
  - dernieres_rencontres stocké brut (string "-1;1;1;1;1")
```

**Nouvelle commande CLI** : `npm run scrape -- --entity=classements --saison=<S> [--level=<N>] [--limit=N]`

**Pas de `--journees=all`** — un seul fetch par poule (1 page suffit pour tout le classement courant).

**Ordre ETL final** : `competitions → phases → poules → equipes → engagements → matchs → arbitres → match_officiels → classements`

## Composants

### Nouveaux fichiers

- `src/schemas/classement.schema.ts` — schéma Zod `raw.classements`
- `src/scrapers/ffhandball/classement.scraper.ts` — `parseClassement(html, sourceUrl, extPouleId)`
- `src/etl/classements.etl.ts` — pipeline `raw.classements → core.classements`
- `db/migrations/0012_classements_enrichissement.sql` — ajout colonnes `id_ffhb` + `dernieres_rencontres`
- `tests/fixtures/ffhandball-poule-classement-lbe.html` (fixture nationale principale)
- `tests/fixtures/ffhandball-poule-classement-vide.html` (fixture cas dégradé — synthétique)
- `tests/schemas/classement.schema.test.ts`
- `tests/scrapers/classement.scraper.test.ts`
- `tests/etl/classements.etl.test.ts`
- `tests/integration/classements-end-to-end.test.ts`

### Fichiers modifiés

- `src/cli/scrape.ts` — handler `scrapeClassements` + dispatch sur `--entity=classements`
- `src/cli/etl.ts` — accepter `--entity=classements`
- `docs/runbook.md` — nouvelle section "Scraper les classements"

## Source de données

### Composant cible : `competitions---classement`

URL : `https://www.ffhandball.fr/competitions/saison-<S>-<ext>/<niveau>/<libelle>-<extCompId>/poule-<extPouleId>/classements/`

Champs d'une ligne de classement (exemple 1re place LBE) :

```json
{
  "id": "10521700",                      // PK Smartfire interne (ignoré)
  "ext_classementId": "59679118",         // ← natural_key
  "pouleId": "193158",                    // PK interne poule (ignoré, on a extPouleId)
  "equipeId": "1237218",                  // PK Smartfire interne équipe (à mapper via equipe_options)
  "place": "1",                           // ← position (string)
  "point": "73",                          // ← points (string)
  "joue": "25",                           // ← matchs joués (string)
  "gagne": "24",                          // ← victoires (string)
  "nul": "0",
  "perdu": "1",
  "butPlus": "849",                       // ← buts pour
  "butMoins": "603",                      // ← buts contre
  "diff": "246",                          // pré-calculé, ignoré (colonne GENERATED en core)
  "dernieresRencontres": "-1;1;1;1;1",    // ← forme récente, 5 derniers résultats
  "equipe_libelle": "BREST BRETAGNE HANDBALL",  // ignoré (déjà en core.equipes)
  "equipe_logoActif": "1",                // ignoré
  "structure_logo": "...png",             // ignoré
  "ext_structureId": "1791"               // ignoré
}
```

**Tous les champs numériques sont des strings** dans la source (même pattern que matchs). Le schéma Zod utilise `z.coerce.number()` pour les coercer.

**`pouleId` interne ≠ `ext_pouleId`** — on utilise `extPouleId` passé en paramètre du parser (garde anti-fuite). Le `pouleId` interne du JSON est ignoré.

### Index `equipe_options` pour résoudre les équipes

Le composant `competitions---poule-selector` est présent sur la page `/classements/` aussi. Il fournit le mapping `id (interne) → ext_equipeId` exactement comme pour les matchs. Réutilisation directe du pattern.

### Cas dégradés observés

- **Compétition sans match joué** : `data.classements = []` (tableau vide). Pas de 404, pas d'erreur. Le scraper retourne `[]` proprement.
- **Équipe avec `equipeId` orphelin** (pas dans `equipe_options`) : ne devrait pas arriver en pratique (même page), mais skip silencieux par sécurité.
- **`dernieresRencontres` partiel** (3 résultats au lieu de 5) : stocké brut tel quel.

## Schéma Zod

### `raw.classements.payload`

```ts
// Helper preprocess pour gérer strings et numbers (source ffhandball.fr expose en strings)
const intFromStringOrNumber = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  },
  z.number().int(),
);

export const rawClassementPayloadSchema = z.object({
  ext_classement_id: z.string().min(1),       // "59679118"
  ext_poule_id: z.string().min(1),
  ext_equipe_id: z.string().min(1),            // résolu via index dans scraper

  position: intFromStringOrNumber,             // place
  points: intFromStringOrNumber,
  joues: intFromStringOrNumber,
  gagnes: intFromStringOrNumber,
  nuls: intFromStringOrNumber,
  perdus: intFromStringOrNumber,
  buts_pour: intFromStringOrNumber,
  buts_contre: intFromStringOrNumber,

  dernieres_rencontres: z.string().optional(),  // brut, ex "-1;1;1;1;1"

  source_url: z.string().url(),
});
export type RawClassementPayload = z.infer<typeof rawClassementPayloadSchema>;
```

**natural_key** : `ext_classement_id`.

## Migration `0012_classements_enrichissement.sql`

```sql
-- raw.classements existe déjà (migration 0001)
-- core.classements existe déjà (migration 0005)

ALTER TABLE core.classements ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.classements ADD COLUMN IF NOT EXISTS dernieres_rencontres TEXT;

ALTER TABLE core.classements ADD CONSTRAINT uq_classements_id_ffhb UNIQUE (id_ffhb);
```

État final `core.classements` :
- `poule_id` (FK NOT NULL)
- `equipe_id` (FK NOT NULL)
- `position` (NOT NULL)
- `points`, `joues`, `gagnes`, `nuls`, `perdus`, `buts_pour`, `buts_contre` (NOT NULL, DEFAULT 0)
- `difference` (GENERATED `buts_pour - buts_contre`)
- `journee_courante` (nullable, pourrait être alimenté plus tard depuis `joue` max)
- `capture_date` (NOT NULL, DEFAULT now())
- `id_ffhb` (nullable, UNIQUE) ← **nouveau**
- `dernieres_rencontres` (nullable, TEXT brut) ← **nouveau**
- PK : `(poule_id, equipe_id)` (composite existant)

## Logique scraper

### `parseClassement(html, sourceUrl, extPouleId): RawClassementPayload[] | null`

1. Charger HTML via cheerio
2. Cibler `competitions---poule-selector` ; absent → return `null`
3. Construire `equipeIdIndex` : `Map<id_interne, ext_equipeId>` depuis `equipe_options[]`
4. Cibler `competitions---classement` ; absent → return `[]` (cas dégradé propre)
5. Pour chaque ligne `data.classements[]` :
   - Lire `equipeId` interne → résoudre via index → `ext_equipe_id`. Si non résolvable, skip
   - Construire `RawClassementPayload`, valider Zod, push si OK
6. Retour : `RawClassementPayload[]`

## Logique CLI scrape — `scrapeClassements(saison, opts)`

```ts
async function scrapeClassements(
  saison: string,
  opts: { level?, limit? },
): Promise<void> {
  const run = await startScrapeRun({ source_site: "ffhandball.fr", scraper_name: "classements", saison });

  try {
    // 1. SELECT poules JOIN phases JOIN competitions (avec detail_url)
    const poulesRes = await query(...);
    let poules = poulesRes.rows;
    if (opts.limit !== undefined) poules = poules.slice(0, opts.limit);

    // 2. Pour chaque poule, fetch /classements/
    let totalInserted = 0;
    let pouleSkipped = 0;
    let pouleVide = 0;
    for (const po of poules) {
      const url = `${po.detail_url}poule-${po.ext_poule_id}/classements/`;
      const res = await fetchHtml(url);
      await run.incrementPages(1);
      if (res.status >= 400) { pouleSkipped++; continue; }

      const parsed = parseClassement(res.body, url, po.ext_poule_id);
      if (parsed === null) { pouleSkipped++; continue; }
      if (parsed.length === 0) { pouleVide++; continue; }

      for (const c of parsed) {
        await insertRaw("classements", {
          scrape_run_id: run.id,
          source_url: c.source_url,
          source_site: "ffhandball.fr",
          natural_key: c.ext_classement_id,
          payload: c,
          saison,
          http_status: res.status,
        });
        totalInserted++;
      }
    }

    logger.info({ totalInserted, pouleSkipped, pouleVide }, "classements scrape done");
    await run.finishSuccess();
  } catch (err) {
    await run.finishFailure(err); throw err;
  }
}
```

## Logique ETL — `runClassementsEtl(saison)`

1. INSERT `core.etl_runs(entity='classements')`
2. SELECT DISTINCT ON (natural_key) depuis `raw.classements WHERE saison = $1 ORDER BY natural_key, scraped_at DESC`
3. Pour chaque ligne :
   - Zod validate → reject → `core.etl_rejets`
   - Résoudre `poule_id` via `core.poules.id_ffhb` → warning + skip si null
   - Résoudre `equipe_id` via `core.equipes.id_ffhb` → warning + skip si null
   - UPSERT `core.classements (poule_id, equipe_id, position, points, ..., id_ffhb, dernieres_rencontres, capture_date)` par `(poule_id, equipe_id)` PK composite :
     - INSERT initial avec tous les champs + `capture_date = now()`
     - ON CONFLICT : UPDATE position, points, joues, etc., `dernieres_rencontres`, `capture_date = now()` à chaque run
4. UPDATE `core.etl_runs` final (success/failed)

**Pas de CASE updated_at** ici car `core.classements` n'a pas de `updated_at` — le snapshot est mis à jour à chaque run via `capture_date`.

## CLI

```bash
# Dev — 5 poules nationales
npm run scrape -- --entity=classements --saison=2025-2026 --level=national --limit=5

# Toutes les poules nationales (~50-100 poules, ~2-3 min)
npm run scrape -- --entity=classements --saison=2025-2026 --level=national

# Run complet 3 niveaux (~5k poules, ~2h à 1.5s/req)
npm run scrape -- --entity=classements --saison=2025-2026

# ETL
npm run etl -- --entity=classements --saison=2025-2026
```

## Tests

### Fixtures à capturer (T1)

- `ffhandball-poule-classement-lbe.html` : LBE poule 168256 `/classements/` (14 équipes classées, données riches)

(Le cas `classements: []` sera testé via HTML synthétique inline, pas besoin de fixture dédiée.)

### Unitaires schéma (5 tests)

- Accepts complete payload (LBE 1ère place)
- Coerces strings to numbers (place, point, joue, etc.)
- `dernieres_rencontres` optional
- Rejects empty ext_classement_id
- Rejects missing position

### Unitaires scraper (5 tests)

- Extracts 14 lignes from LBE fixture, position correcte, équipes résolvables
- Returns [] when classement component is absent but poule-selector present (synthétique)
- Returns null when poule-selector is absent
- Skips lignes whose equipeId is not in equipe_options (synthétique)
- Coercion : tous les ints sont bien des numbers en sortie

### Unitaires ETL (8 tests)

- Insert nominal : 3 FKs résolues, tous les champs propagés, `capture_date` populé
- `dernieres_rencontres` propagé tel quel
- `id_ffhb` propagé
- Warning + skip si FK poule non résolue
- Warning + skip si FK équipe non résolue
- Rejet Zod (payload invalide)
- Idempotence (re-run → mêmes counts par PK)
- Re-run met à jour `capture_date` ET les valeurs si elles changent (transitions de classement entre journées)
- `afterAll(closePool)` à la fin

### Intégration end-to-end (2 tests)

- Setup : seed competition + phase + poule + 14 équipes
- Parse fixture LBE classement → insertRaw → run ETL → assert 14 lignes core, position 1 = 73 points, etc.
- Idempotence : 2 runs ETL → mêmes counts, capture_date bouge

## Cas dégradés

| Cas | Comportement |
|---|---|
| `competitions---classement` absent | Scraper retourne `[]` ; ETL ignore la poule |
| `data.classements` vide (début de saison) | Idem : `[]`, log info, pas d'insert |
| `equipeId` non dans `equipe_options` | Skip silencieux scraper (log debug) |
| `dernieres_rencontres` partiel ou absent | Stocké tel quel ou undefined |
| Score string mal formé (ex `"abc"`) | Préprocess Zod → undefined → reject ligne |
| Match déjà en core, classement change (entre journées) | UPSERT met à jour stats + capture_date |
| 429 / rate-limit | Helper `fetchHtml` gère retry/backoff existant |
| Migration 0012 si `core.classements` non-vide | Safe : ADD COLUMN nullable + UNIQUE sur nullable autorise plusieurs NULL |

## Volumétrie attendue

| Mode | Requêtes | Durée @1.5s | Lignes classements |
|---|---|---|---|
| `--level=national --limit=5` | 5 | 8s | ~70 |
| `--level=national` (50-100 poules) | 50-100 | 2-3 min | ~700-1400 |
| 3 niveaux complet | ~5000 | **~2h** | ~50-70k |

Beaucoup plus raisonnable que `matchs --journees=all` (17-33h) — un seul fetch par poule.

## Pipeline state après cette feature

```
✅ clubs (listing + détail enrichi)
✅ salles
✅ competitions + phases + poules
✅ equipes + engagements
✅ matchs
✅ arbitres + match_officiels
✅ classements                  ← cette feature
⏭ stats_joueurs (national uniquement, core.stats_joueurs nouveau)
⏭ Résolutions FK différées (clubs↔equipes, salles↔matchs, club_rattachement_id↔arbitres)
```

## Future feature liée

- **Historique des classements** : actuellement `core.classements` stocke uniquement l'état courant (UPSERT écrase). Pour avoir un historique journée-par-journée, créer `core.classements_snapshots(poule_id, equipe_id, journee, position, points, ..., snapshot_date)` peuplée à chaque ETL run. Hors scope ici (déjà bien servi par `dernieres_rencontres` pour les 5 derniers résultats).
- **Classements cross-poule agrégés** : vues SQL à construire côté API (best buteurs ligue, meilleure défense par niveau, etc.). Pas d'ETL.
