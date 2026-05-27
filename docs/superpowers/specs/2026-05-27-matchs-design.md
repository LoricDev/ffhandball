---
name: Matchs (rencontres)
description: Design de la 5ème entité du pipeline ffhandball — rencontres individuelles avec date, scores, équipes, depuis le composant rencontre-list par poule
type: spec
date: 2026-05-27
---

# Matchs (rencontres)

## Contexte

Les 4 premières entités structurelles du pipeline sont en place :
- `clubs` + `salles`
- `competitions` + `phases` + `poules`
- `equipes` + `engagements`

Cette spec couvre la 5ème entité : les **matchs** (rencontres) — la donnée d'activité centrale du pipeline. Source : composant `competitions---rencontre-list` exposé sur chaque page poule de `ffhandball.fr`.

⚠️ L'entité `joueurs + licences` initialement prévue à cette étape du pipeline a été **reportée** : les données individuelles licenciés sont derrière login GestHand (RGPD), non scrapables publiquement. Seules les stats joueurs en compétitions nationales sont exposées — entité séparée à traiter ultérieurement si besoin.

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Alimenter `core.matchs` avec toutes les rencontres exposées par `ffhandball.fr` (3 niveaux : national, régional, départemental)
- Supporter deux modes de scraping :
  - **Mode `--journees=courante`** (défaut) : 1 requête par poule, seulement la journée courante. ~1500-3000 requêtes total, ~1h.
  - **Mode `--journees=all`** : itération sur toutes les journées de chaque poule. ~40-80k requêtes total, ~17-33h (nocturne multi-nuits).
- Préserver l'idempotence : un re-run met à jour les scores (transitions `a_jouer → joue`)
- Stocker `equipement_id` (ID numérique salle source) pour résolution FK future
- Conserver les données arbitres en raw payload pour future feature dédiée (pas de propagation en core dans cette spec)

## Non-objectifs

- Pas de résolution FK `salle_id` dans cette feature — la colonne reste NULL, `equipement_id` (text) est stocké pour résolution différée
- Pas d'insertion dans `core.arbitres` ni `core.match_officiels` — données conservées en payload `raw.matchs` pour une future feature dédiée
- Pas de détection des statuts `reporte`/`annule`/`forfait` — non détectables depuis `rencontre-list` (statuts déduits : `joue` si scores complets, sinon `a_jouer`)
- Pas de scraping des compositions d'équipe ni stats individuelles joueurs (entité distincte, scope national)
- Pas de scraping de la "feuille de match" (`fdmCode` opaque conservé en raw mais pas exploité)

## Architecture

```
core.poules (lue depuis core, déjà peuplée par feature équipes+engagements)
        │
        ▼ Pour chaque poule (avec son extPouleId + detail_url compétition) :
        │
fetch /competitions/.../<libelle>-<extCompId>/poule-<extPouleId>/[?numero_journee=N]
        │
        ▼
parseRencontreList(html, sourceUrl, extPouleId) :
  - Cible competitions---poule-selector → index equipe_options (id interne → ext_equipeId)
                                       + journees_disponibles[]
  - Cible competitions---rencontre-list → data.rencontres[]
  - Pour chaque rencontre :
      * Résoudre ext_equipe_dom_id / ext_equipe_ext_id via index
      * Garder uniquement les matchs dont extPouleId == extPouleId attendu
      * Skip si équipes non résolvables ou égales
  - Retour : { matchs: RawMatchPayload[], journees_disponibles: number[] }
        │
        ▼
raw.matchs (natural_key = ext_rencontre_id)
        │
        ▼
matchs.etl → core.matchs :
  - Résolution FK : poule_id, equipe_dom_id, equipe_ext_id (warning + skip si non résolvable)
  - Cast date_heure : Postgres natif via $::timestamptz
  - Déduction statut : 'joue' si score_dom IS NOT NULL AND score_ext IS NOT NULL, sinon 'a_jouer'
  - Déduction heure_estimee : true si date_heure se termine par T00:00:00
  - salle_id = NULL (cette feature), equipement_id stocké tel quel
  - UPSERT par id_ffhb_match (UNIQUE existant), COALESCE sur scores, CASE updated_at conditionnel
```

**Nouvelle commande CLI** : `npm run scrape -- --entity=matchs --saison=<S> [--level=<N>] [--journees=all|courante] [--limit=N]`

**Ordre ETL complet après cette feature** : `competitions → phases → poules → equipes → engagements → matchs`

## Composants

### Nouveaux fichiers

- `src/schemas/match.schema.ts` — schéma Zod `raw.matchs`
- `src/scrapers/ffhandball/rencontre-list.scraper.ts` — `parseRencontreList(html, sourceUrl, extPouleId)`
- `src/etl/matchs.etl.ts` — pipeline `raw.matchs → core.matchs`
- `db/migrations/0010_matchs_equipement.sql` — `ALTER core.matchs ADD COLUMN equipement_id TEXT` + index
- `tests/fixtures/ffhandball-poule-rencontres-journee-en-cours.html` (LBE poule courante)
- `tests/fixtures/ffhandball-poule-rencontres-journee-1.html` (LBE journée 1, matchs joués)
- `tests/scrapers/rencontre-list.scraper.test.ts`
- `tests/etl/matchs.etl.test.ts`
- `tests/integration/matchs-end-to-end.test.ts`

### Fichiers modifiés

- `src/cli/scrape.ts` — nouveau handler `scrapeMatchs` + dispatch sur `--entity=matchs` + nouvelles options `--level/--journees/--limit` (réutilisation)
- `src/cli/args.ts` — accepter `--journees=all|courante` (si pas déjà)
- `src/cli/etl.ts` — accepter `--entity=matchs`
- `docs/runbook.md` — nouvelle section "Scraper les matchs (rencontres)"

## Source de données

### Composant principal : `competitions---rencontre-list`

URL : `https://www.ffhandball.fr/competitions/saison-<S>-<ext>/<niveau>/<libelle>-<extCompId>/poule-<extPouleId>/[?numero_journee=N]`

**Important** : par défaut, la page charge **la journée courante**. Pour scraper toutes les journées, itérer en query string `?numero_journee=1`, `?numero_journee=2`, etc., jusqu'au max.

Champs d'une rencontre :

```json
{
  "id": "1941811",                    // PK interne (ignoré)
  "ext_rencontreId": "2388869",       // ← natural_key
  "pouleId": "193158",                // PK interne poule (ignoré)
  "extPouleId": "168256",             // ← FK poule directe (= core.poules.id_ffhb)
  "equipe1Id": "1237220",             // PK interne équipe dom (à mapper via equipe_options)
  "equipe2Id": "1237229",             // PK interne équipe ext (à mapper)
  "equipe1Score": null,               // number ou null
  "equipe2Score": null,
  "equipe1ScoreMT": null,
  "equipe2ScoreMT": null,
  "date": "2026-05-27T20:00:00+02:00",   // ISO 8601 + TZ
  "fdmCode": "VAGARIM",
  "equipementId": "2348",             // ID numérique salle (futur match FK)
  "arbitre1": "CHIFFOLEAU JULES",
  "arbitre1Id": "350466",
  "arbitre2": "CHIFFOLEAU MAX",
  "arbitre2Id": "350465",
  "journeeNumero": "25",
  "equipe1Libelle": "...",            // déjà en core.equipes.nom, ignoré
  "equipe2Libelle": "..."
}
```

### Index `equipe_options` pour résoudre les équipes

Les rencontres exposent `equipe1Id` / `equipe2Id` en **PK Smartfire interne**, pas en `ext_equipeId`. Heureusement, `competitions---poule-selector.equipe_options[]` (présent dans la même page) fournit le mapping `id (interne) → ext_equipeId`.

Le scraper construit l'index en début de parse et résout chaque match.

### Liste des journées disponibles

Le champ `poule-selector.poules[].journees` (JSON stringifié) contient les N journées avec leurs plages de dates. Le scraper l'utilise pour itérer en mode `--journees=all`.

## Schéma Zod

### `raw.matchs.payload`

```ts
export const rawMatchPayloadSchema = z.object({
  ext_rencontre_id: z.string().min(1),
  ext_poule_id: z.string().min(1),
  ext_equipe_dom_id: z.string().min(1),
  ext_equipe_ext_id: z.string().min(1),
  date_heure: z.string().datetime({ offset: true }),

  score_dom: z.number().int().nullable().optional(),
  score_ext: z.number().int().nullable().optional(),
  score_mt_dom: z.number().int().nullable().optional(),
  score_mt_ext: z.number().int().nullable().optional(),

  journee: z.coerce.number().int().positive(),
  equipement_id: z.string().optional(),
  fdm_code: z.string().optional(),

  // Arbitres en raw payload, pas propagés en core (future feature)
  arbitre1_id: z.string().optional(),
  arbitre1_nom: z.string().optional(),
  arbitre2_id: z.string().optional(),
  arbitre2_nom: z.string().optional(),

  source_url: z.string().url(),
});
export type RawMatchPayload = z.infer<typeof rawMatchPayloadSchema>;
```

**natural_key** : `ext_rencontre_id`.

## Migration `0010_matchs_equipement.sql`

```sql
-- raw.matchs existe déjà (migration 0001)
-- core.matchs existe déjà (migration 0005) avec tout le nécessaire sauf equipement_id

ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS equipement_id TEXT;
CREATE INDEX IF NOT EXISTS idx_matchs_equipement_id ON core.matchs (equipement_id);
```

État de `core.matchs` après migration :
- `id_ffhb_match` (UNIQUE, natural key, recevra `ext_rencontre_id`)
- `poule_id`, `equipe_dom_id`, `equipe_ext_id` (FK NOT NULL)
- `date_heure TIMESTAMPTZ NOT NULL`
- `heure_estimee BOOLEAN NOT NULL DEFAULT false`
- `salle_id BIGINT NULL FK → core.salles` (reste NULL dans cette feature)
- `score_dom/ext`, `score_mt_dom/ext` (nullable)
- `statut` CHECK(`a_jouer`/`joue`/`reporte`/`annule`/`forfait`), valeur déduite dans cette feature ∈ {`a_jouer`, `joue`}
- `journee` (nullable)
- `equipement_id TEXT NULL` ← nouveau
- `feuille_validee BOOLEAN NOT NULL DEFAULT false` (reste à false, hors scope)
- CHECK `chk_matchs_equipes_distinctes (equipe_dom_id <> equipe_ext_id)`

## Logique scraper

### `parseRencontreList(html, sourceUrl, extPouleId)`

1. Charger HTML via cheerio
2. Cibler `competitions---poule-selector` ; absent → return null
3. Construire `equipeIdIndex` : `Map<id_interne, ext_equipeId>` depuis `equipe_options[]`
4. Extraire `journees_disponibles` depuis `selected_poule.journees` (JSON stringifié, parser puis map `j.journee_numero`)
5. Cibler `competitions---rencontre-list` ; absent → return `{ matchs: [], journees_disponibles }`
6. Pour chaque rencontre :
   - Skip si `extPouleId !== extPouleId attendu` (garde anti-fuite cross-poule)
   - Résoudre `ext_equipe_dom_id` et `ext_equipe_ext_id` via index ; skip si non résolvable
   - Skip si `ext_equipe_dom_id === ext_equipe_ext_id` (garde équipes distinctes)
   - Construire `RawMatchPayload`, valider Zod, push si OK
7. Retour : `{ matchs, journees_disponibles }`

### Handler CLI `scrapeMatchs(saison, opts)`

1. Resolve `ext_saison_id` (réutilise `extractExtSaisonId` de la feature compétitions)
2. SELECT depuis `core.poules` JOIN `core.phases` JOIN `core.competitions` pour récupérer chaque poule avec son `ext_poule_id`, `ext_competition_id`, `niveau`, `detail_url`
3. Filtrer par `--level` si fourni ; appliquer `--limit` si fourni
4. Pour chaque poule :
   - Build URL : `${detail_url}poule-${ext_poule_id}/`
   - Fetch journée courante → `parseRencontreList` → `insertRaw("matchs", ...)`
   - Si `--journees=all` ET `journees_disponibles.length > 1` :
     - Identifier la journée courante (depuis `matchs[0].journee` ou la première journée valide)
     - Pour chaque autre journée : fetch `?numero_journee=N` → parse → insertRaw
5. Mark `scrape_run` `success` / `partial` / `failed`

**Rate-limit** : respecté par `fetchHtml` existant (1.5s).

## Logique ETL — `runMatchsEtl(saison)`

1. Créer `core.etl_runs (entity='matchs')`
2. SELECT DISTINCT ON (natural_key) depuis `raw.matchs WHERE saison = $1`
3. Pour chaque ligne :
   - Zod validate → reject → `core.etl_rejets`
   - Résoudre `poule_id` via `core.poules.id_ffhb` → warning + skip si null
   - Résoudre `equipe_dom_id` via `core.equipes.id_ffhb` → warning + skip si null
   - Résoudre `equipe_ext_id` via `core.equipes.id_ffhb` → warning + skip si null
   - Si `equipe_dom_id === equipe_ext_id` : skip + warning (CHECK contrainte violée)
   - Déduire `statut` : `'joue'` si `score_dom IS NOT NULL AND score_ext IS NOT NULL`, sinon `'a_jouer'`
   - Déduire `heure_estimee` : `date_heure.endsWith("T00:00:00")` (basé sur la string ISO 8601)
   - UPSERT `core.matchs` par `id_ffhb_match` (UNIQUE existant) :
     - INSERT initial avec tous les champs
     - ON CONFLICT : COALESCE scores (un score null n'écrase pas un score non-null), CASE `updated_at` conditionnel sur (poule_id, équipes, date_heure, scores, statut, journee, equipement_id)
   - `last_seen_at = now()` à chaque run
4. UPDATE `core.etl_runs` final (success/failed)

## CLI

```bash
# Dev — test rapide
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --limit=5

# Journée courante toutes ligues nationales (~50-100 poules, ~2-3 min)
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national

# Toutes journées nationales (~1300-2600 req, ~30-65 min)
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --journees=all

# Journée courante 3 niveaux (~1500-3000 req, ~1h)
npm run scrape -- --entity=matchs --saison=2025-2026

# Run complet 3 niveaux toutes journées (~40-80k req, 17-33h sur plusieurs nuits)
npm run scrape -- --entity=matchs --saison=2025-2026 --journees=all

# ETL
npm run etl -- --entity=matchs --saison=2025-2026
```

## Tests

### Fixtures à capturer (T1)

- `ffhandball-poule-rencontres-journee-en-cours.html` : LBE poule 168256, journée courante (matchs à venir, scores null)
- `ffhandball-poule-rencontres-journee-1.html` : LBE poule 168256 `?numero_journee=1` (matchs joués, scores remplis)

### Unitaires scraper

`tests/scrapers/rencontre-list.scraper.test.ts` :
- Extraction matchs depuis journée courante (≥1 match, `journees_disponibles` non vide)
- Extraction matchs joués depuis journée 1 (scores propagés)
- Résolution `equipe1Id`/`equipe2Id` via `equipe_options` → `ext_equipe_dom_id`/`ext_equipe_ext_id` corrects (chiffres FFHB)
- Skip rencontre dont équipe absente de `equipe_options` (HTML synthétique)
- Skip rencontre dont `extPouleId` ne matche pas la poule attendue (garde anti-fuite)
- Retour `{ matchs: [], journees_disponibles: [...] }` si `rencontre-list` absent mais `poule-selector` présent
- Retour `null` si `poule-selector` absent
- Garde "équipes distinctes" : skip si `equipe1Id === equipe2Id`

### Unitaires ETL

`tests/etl/matchs.etl.test.ts` :
- Insert match nominal : 3 FKs résolues, scores propagés, `statut='joue'`
- Déduction `statut='a_jouer'` quand scores null
- Déduction `heure_estimee=true` quand `date_heure` se termine par `T00:00:00`
- Warning + skip si FK poule non résolue
- Warning + skip si FK equipe_dom non résolue
- Warning + skip si FK equipe_ext non résolue
- Rejet Zod (payload invalide)
- Idempotence (re-run → mêmes counts, pas de doublon)
- Update `updated_at` quand le score change (transition `a_jouer → joue`)
- `equipement_id` stocké, `salle_id` reste NULL
- Garde "équipes distinctes" : skip + warning si `equipe_dom_id === equipe_ext_id` après résolution
- `afterAll(closePool)` à la fin

### Intégration end-to-end

`tests/integration/matchs-end-to-end.test.ts` :
- Setup : seed competition + phase + poule + 2 équipes
- Parse fixture rencontre-list → insertRaw matchs (2-3 matchs)
- Run `matchsEtl` → assertions counts core, FKs résolues, statuts cohérents
- Test transition score : insert match sans score → run ETL → mise à jour raw avec scores → run ETL → vérifier statut `a_jouer → joue` et `updated_at` bouge
- Re-run ETL idempotent

## Cas dégradés

| Cas | Comportement |
|---|---|
| `rencontre-list` absent sur une poule | Scraper retourne matchs vides ; ETL ignore cette poule |
| `equipe1Id` non dans `equipe_options` | Skip silencieux scraper (log debug) |
| `extPouleId` du match ≠ poule attendue | Skip (garde anti-fuite) |
| `equipe1Id === equipe2Id` (théorique) | Skip + log warning ; ETL skip aussi si jamais |
| `date` invalide/absente | Zod reject → `core.etl_rejets` |
| `equipementId` null/absent | `equipement_id` NULL en core, pas de warning |
| Score partiel (un sur deux) | `statut='a_jouer'`, pas `joue` ; log info |
| `--journees=all` mais `journees` mal formé | Scraper ne fait que la journée courante, log warning |
| Match déjà en core, score mis à jour | UPSERT met à jour scores + statut + `updated_at` (CASE conditionnel) |
| Score `null` côté source écraserait un score non-null en core | Empêché par COALESCE dans UPSERT |
| `--journees=all` interrompu | Append-only raw, re-lancement reprend les journées manquantes via natural_key UNIQUE |
| Rate-limit dépassé (429) | Backoff helper existant (`fetchHtml`) |
| Match avec statut `reporte`/`annule`/`forfait` côté source | Non détectable depuis `rencontre-list`. Le match reste en `a_jouer` ou `joue` selon scores |

## Volumétrie attendue

| Mode | Requêtes | Durée @1.5s | Matchs |
|---|---|---|---|
| `--level=national --limit=5` | ~5 | 8s | ~50 |
| `--level=national` (journée courante) | ~50-100 | 2-3 min | ~300-700 |
| `--level=national --journees=all` | ~1.3-2.6k | 30-65 min | ~10-20k |
| Défaut 3 niveaux (journée courante) | ~1.5-3k | ~1h | ~10-20k |
| 3 niveaux `--journees=all` | ~40-80k | **17-33h multi-nuits** | ~50-200k |

## Pipeline state après cette feature

```
✅ clubs (listing + détail enrichi)
✅ salles
✅ competitions + phases + poules
✅ equipes + engagements
✅ matchs                       ← cette feature
⏭ arbitres + match_officiels   ← future (depuis raw.matchs.payload, sans re-scrape)
⏭ classements
⏭ stats joueurs (national uniquement)
⏭ résolution FK club_id (equipes)
⏭ résolution FK salle_id (matchs)
```

## Features futures liées

Plusieurs sont déjà préparées par cette feature :

1. **Arbitres + match_officiels** : les champs `arbitre1_id/nom`, `arbitre2_id/nom` sont déjà stockés en `raw.matchs.payload`. Une future ETL `arbitres.etl` lira depuis `raw.matchs` et alimentera `core.arbitres` + `core.match_officiels` sans re-scrape.

2. **Résolution FK salle_id** : la colonne `core.matchs.equipement_id` permet de matcher avec les salles. Approches possibles : (a) enrichir `core.salles` avec `equipement_id` via un autre scraping, (b) page détail rencontre si elle apparaît publiquement plus tard.

3. **Statuts `reporte`/`annule`/`forfait`** : nécessite une source supplémentaire (page détail rencontre, ou champ `fdmCode` mappé).

4. **Stats joueurs (scope national)** : composant `competitions---stats-joueurs` exposé pour les compétitions avec `afficherStatsJoueurs="1"`. Entité distincte `core.stats_joueurs` (pas la table existante `core.joueurs` qui reste inutilisable sans GestHand).
