---
name: Arbitres et officiels de match
description: Design de la 6ème entité du pipeline ffhandball — extraction des arbitres depuis raw.matchs.payload (pas de re-scrape)
type: spec
date: 2026-05-27
---

# Arbitres et match_officiels

## Contexte

Les 5 premières entités du pipeline sont en place :
- `clubs` + `salles`
- `competitions` + `phases` + `poules`
- `equipes` + `engagements`
- `matchs`

Lors du scraping des matchs (feature précédente), les champs `arbitre1_id/nom`, `arbitre2_id/nom` ont été conservés dans `raw.matchs.payload` mais pas propagés en core. Cette spec couvre l'extraction de ces données vers `core.arbitres` et `core.match_officiels` — **sans nouveau scraping**.

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Alimenter `core.arbitres` (une ligne par arbitre unique) avec `id_ffhb` (= arbitre source ID), `nom`, `prenom`, `nom_complet` (backup brut)
- Alimenter `core.match_officiels` (M:N entre matchs et arbitres) avec `role ∈ {arbitre_1, arbitre_2}` selon la position dans le match
- Préserver l'idempotence : un re-run met à jour les noms si ils changent côté source
- Aucune dépendance sur un nouveau scraping (toutes les données viennent de `raw.matchs.payload`)
- Assouplir `core.arbitres` pour s'adapter à la source publique (pas de `numero_licence` FFHB officiel disponible)

## Non-objectifs

- Pas de scraping de pages dédiées arbitres (n'existent pas publiquement)
- Pas de résolution du `numero_licence` FFHB officiel (derrière login GestHand, même contrainte que pour les joueurs)
- Pas de résolution `club_rattachement_id` (le club de l'arbitre n'est pas exposé dans `rencontre-list`)
- Pas d'inférence du `niveau` arbitre (T1, T2, départemental, etc. — pas exposé)
- Pas de gestion des rôles `delegue`, `observateur`, `chrono` — la source ne les expose pas
- Pas de re-scraping des matchs (les données arbitres sont déjà dans `raw.matchs.payload`)

## Architecture

```
raw.matchs.payload (existant, déjà peuplé par feature matchs)
  Contient : arbitre1_id, arbitre1_nom, arbitre2_id, arbitre2_nom (optionnels)
        │
        ▼
ETL arbitres :
  - SELECT DISTINCT arbitres uniques depuis raw.matchs (UNION arbitre1 + arbitre2)
  - Pour chaque : split nom_complet → nom + prenom (best effort)
  - UPSERT core.arbitres par id_ffhb
        │
        ▼
core.arbitres
        │
        ▼
ETL match_officiels :
  - SELECT raw.matchs avec arbitre1 et/ou arbitre2 présents
  - Résoudre match_id (via core.matchs.id_ffhb_match) et arbitre_id (via core.arbitres.id_ffhb)
  - Pour chaque arbitre présent : INSERT (match_id, arbitre_id, role) ON CONFLICT DO NOTHING
        │
        ▼
core.match_officiels (PK composite (match_id, arbitre_id, role))
```

**Aucun nouveau scraper, aucune nouvelle table raw.** Tout vient de `raw.matchs` (déjà peuplé).

**Ordre ETL complet après cette feature** : `competitions → phases → poules → equipes → engagements → matchs → arbitres → match_officiels`

## Composants

### Nouveaux fichiers

- `src/etl/arbitres.etl.ts` — pipeline `raw.matchs → core.arbitres`
- `src/etl/match_officiels.etl.ts` — pipeline `raw.matchs → core.match_officiels`
- `src/etl/shared/split-nom-complet.ts` — helper pur de split (testable séparément)
- `db/migrations/0011_arbitres_assouplissement.sql` — assouplit `core.arbitres`
- `tests/etl/shared/split-nom-complet.test.ts`
- `tests/etl/arbitres.etl.test.ts`
- `tests/etl/match_officiels.etl.test.ts`
- `tests/integration/arbitres-officiels-end-to-end.test.ts`

### Fichiers modifiés

- `src/cli/etl.ts` — accepter `--entity={arbitres,match_officiels}`
- `docs/runbook.md` — nouvelle section "Arbitres et match_officiels"

## Source de données

### Champs disponibles dans `raw.matchs.payload`

```json
{
  "ext_rencontre_id": "2388701",
  "ext_poule_id": "168256",
  ...,
  "arbitre1_id": "286170",
  "arbitre1_nom": "CHAMI MILOUD",
  "arbitre2_id": "284440",
  "arbitre2_nom": "MILI AISSAME"
}
```

**Format observé** :
- `arbitre*_id` : chaîne numérique 5-7 chiffres (Smartfire interne, **pas un numéro de licence FFHB officiel**)
- `arbitre*_nom` : chaîne brute en majuscules, format `"NOM PRENOM"` (convention FFHB)
- Les 4 champs sont **tous optionnels** — un match peut avoir 0, 1 ou 2 arbitres dans `rencontre-list` (typiquement 2)

### Heuristique split nom/prenom

Convention française FFHB : NOM en majuscules suivi du Prénom. Exemples observés :
- `"CHAMI MILOUD"` → `nom = "CHAMI"`, `prenom = "MILOUD"`
- `"COURNIL MATHILDE"` → `nom = "COURNIL"`, `prenom = "MATHILDE"`
- `"JEAN-PIERRE DUPOND-MARTIN"` → `nom = "JEAN-PIERRE"`, `prenom = "DUPOND-MARTIN"` (premier mot)
- `"MUSTAFA"` (un seul mot, rare) → `nom = "MUSTAFA"`, `prenom = null`

**Limite assumée** : ~5% d'erreurs attendues (prénoms composés non détectés, noms à particule). Le `nom_complet` brut est conservé pour permettre une réconciliation manuelle ou un fuzzy match ultérieur. Une feature future "résolution arbitres FFHB" pourrait améliorer ça via matching nom/club.

## Migration `0011_arbitres_assouplissement.sql`

```sql
ALTER TABLE core.arbitres ALTER COLUMN numero_licence DROP NOT NULL;
ALTER TABLE core.arbitres ALTER COLUMN prenom DROP NOT NULL;

ALTER TABLE core.arbitres ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.arbitres ADD COLUMN IF NOT EXISTS nom_complet TEXT;

ALTER TABLE core.arbitres ADD CONSTRAINT uq_arbitres_id_ffhb UNIQUE (id_ffhb);

CREATE INDEX IF NOT EXISTS idx_arbitres_nom_trgm
  ON core.arbitres USING gin (nom gin_trgm_ops);
```

État final `core.arbitres` :
- `id` (PK)
- `numero_licence` (nullable, futur enrichissement GestHand)
- `id_ffhb` (UNIQUE, recevra `arbitre1_id` ou `arbitre2_id`)
- `nom` (NOT NULL)
- `prenom` (nullable)
- `nom_complet` (nullable, backup brut)
- `niveau`, `club_rattachement_id` (nullable, hors scope)
- `created_at`, `updated_at`, `last_seen_at`

`core.match_officiels` reste inchangée (structure déjà correcte : `(match_id, arbitre_id, role)` UNIQUE composite, CHECK role).

## Helper `splitNomComplet`

```ts
// src/etl/shared/split-nom-complet.ts
export function splitNomComplet(nomComplet: string): { nom: string; prenom: string | null } {
  const parts = nomComplet.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") {
    throw new Error(`Empty nom_complet`);
  }
  if (parts.length === 1) {
    return { nom: parts[0]!, prenom: null };
  }
  return { nom: parts[0]!, prenom: parts.slice(1).join(" ") };
}
```

Tests dédiés couvrent : 2 mots simple, 1 mot, prénoms composés (3+ mots), espaces multiples, chaîne vide (throw).

## Logique ETL

### `runArbitresEtl(saison)`

```sql
-- Extraction des arbitres uniques depuis raw.matchs
SELECT DISTINCT id_ffhb, nom_complet
FROM (
  SELECT
    payload->>'arbitre1_id'  AS id_ffhb,
    payload->>'arbitre1_nom' AS nom_complet
  FROM raw.matchs
  WHERE saison = $1
    AND payload->>'arbitre1_id' IS NOT NULL
    AND payload->>'arbitre1_nom' IS NOT NULL
  UNION
  SELECT
    payload->>'arbitre2_id'  AS id_ffhb,
    payload->>'arbitre2_nom' AS nom_complet
  FROM raw.matchs
  WHERE saison = $1
    AND payload->>'arbitre2_id' IS NOT NULL
    AND payload->>'arbitre2_nom' IS NOT NULL
) AS arbitres_uniques
WHERE id_ffhb <> '' AND nom_complet <> '';
```

Pour chaque ligne :
- Validate `id_ffhb` non vide
- Splitter `nom_complet` → `{ nom, prenom }`
- UPSERT `core.arbitres (id_ffhb, nom, prenom, nom_complet)` ON CONFLICT (id_ffhb) DO UPDATE avec COALESCE et CASE updated_at conditionnel
- `last_seen_at = NOW()`

**Note** : la déduplication est faite côté SQL via UNION DISTINCT — un arbitre apparaissant dans 1000 matchs ne sera traité qu'une fois.

**Pas de raw rejets** (les données ont déjà été validées au scrape matchs). Pas de warnings spécifiques.

### `runMatchOfficielsEtl(saison)`

```sql
-- Une ligne par (match, arbitre, role) à insérer
SELECT
  payload->>'ext_rencontre_id' AS ext_rencontre_id,
  payload->>'arbitre1_id'      AS arbitre1_id,
  payload->>'arbitre2_id'      AS arbitre2_id
FROM raw.matchs
WHERE saison = $1;
```

⚠️ On utilise `raw.matchs` mais on doit **dédupliquer par ext_rencontre_id** (DISTINCT ON pour garder la version la plus récente) — sinon un re-scrape qui aurait inséré plusieurs lignes en raw pourrait causer des conflits.

Algorithme par ligne raw :
- Résoudre `match_id` via `SELECT id FROM core.matchs WHERE id_ffhb_match = $1` → warning + skip si null
- Si `arbitre1_id` présent : résoudre `arbitre_id` via `core.arbitres.id_ffhb` → INSERT `(match_id, arbitre_id, 'arbitre_1')` ON CONFLICT DO NOTHING
- Si `arbitre2_id` présent : idem avec rôle `'arbitre_2'`
- Si un des arbitres n'a pas de ligne en `core.arbitres` (probabilité faible si on lance arbitres ETL avant) : warning + skip cet arbitre uniquement (l'autre peut quand même être inséré)

Idempotence assurée par UNIQUE `(match_id, arbitre_id, role)` + ON CONFLICT DO NOTHING.

## CLI

```bash
# Pré-requis : raw.matchs déjà peuplée
npm run etl -- --entity=matchs          --saison=2025-2026   # déjà fait

# Nouveaux ETLs (ordre obligatoire)
npm run etl -- --entity=arbitres        --saison=2025-2026
npm run etl -- --entity=match_officiels --saison=2025-2026
```

L'ordre `arbitres → match_officiels` est obligatoire (le second résout FK vers `core.arbitres`).

## Tests

### Helper splitNomComplet

`tests/etl/shared/split-nom-complet.test.ts` (5 tests) :
- 2 mots : `"CHAMI MILOUD"` → `nom=CHAMI, prenom=MILOUD`
- 1 mot : `"TOTO"` → `nom=TOTO, prenom=null`
- 3+ mots : `"JEAN-PIERRE DUPOND MARTIN"` → `nom=JEAN-PIERRE, prenom=DUPOND MARTIN`
- Espaces multiples : `"  CHAMI   MILOUD  "` → `nom=CHAMI, prenom=MILOUD`
- Chaîne vide : throw

### ETL arbitres

`tests/etl/arbitres.etl.test.ts` (5 tests) :
- "extracts unique arbitres from raw.matchs (UNION arbitre1 + arbitre2)" : 2 matchs avec arbitres différents → 4 arbitres uniques en core
- "deduplicates same arbitre appearing in multiple matchs" : 3 matchs avec arbitre1_id='286170' → 1 ligne core.arbitres
- "splits nom and prenom via helper" : payload avec "CHAMI MILOUD" → `nom='CHAMI'`, `prenom='MILOUD'`, `nom_complet='CHAMI MILOUD'`
- "skips raw matchs with no arbitre data" : payload sans arbitre1_id/arbitre2_id → 0 lignes core
- "is idempotent" : 2 runs → mêmes counts

### ETL match_officiels

`tests/etl/match_officiels.etl.test.ts` (5 tests) :
- "inserts 2 lignes (arbitre_1, arbitre_2) when both arbitres present" : seed match + 2 arbitres en core → 2 lignes en core.match_officiels
- "inserts only arbitre_1 when arbitre2_id is absent" → 1 ligne
- "warns and skips when match FK not resolved"
- "warns and skips one arbitre when its FK not resolved (other is inserted)"
- "is idempotent via ON CONFLICT DO NOTHING on PK (match, arbitre, role)"
- `afterAll(closePool)` à la fin

### Intégration

`tests/integration/arbitres-officiels-end-to-end.test.ts` (1-2 tests) :
- Seed competition + phase + poule + 2 équipes → insertRaw matchs avec arbitres → run matchs ETL → run arbitres ETL → run match_officiels ETL → assert counts
- Idempotence du re-run

## Cas dégradés

| Cas | Comportement |
|---|---|
| `arbitre1_nom` vide mais `arbitre1_id` présent | Skip silencieux (filtre WHERE dans SELECT) |
| `arbitre1_id` vide mais `arbitre1_nom` présent | Skip silencieux |
| Match avec 0 arbitre | Aucune insertion match_officiels pour ce match |
| Match avec 1 arbitre seulement (arbitre2 manquant) | 1 seule insertion (arbitre_1) |
| `match_officiels` lancé avant `arbitres` | Warnings massifs (FK arbitres) + skip ; re-run après `arbitres` résout |
| Nom à particule "DE LA TORRE PIERRE" | Split donne `nom="DE", prenom="LA TORRE PIERRE"` — erreur connue, nom_complet conservé pour résolution future |
| Arbitre apparaissant dans 1000 matchs | UNION DISTINCT déduplique côté SQL, 1 seule ligne core.arbitres |
| Re-run ETL après mise à jour nom (rare) | UPSERT met à jour nom/prenom, CASE updated_at bouge |
| Migration 0011 sur `core.arbitres` non-vide (régression future) | DROP NOT NULL safe ; ADD COLUMN safe ; le UNIQUE constraint sur id_ffhb créera des NULL si pas de matching → OK |

## Volumétrie attendue

| Mode | Lignes raw.matchs | Arbitres uniques | match_officiels |
|---|---|---|---|
| Smoke test (T9 matchs ~19 matchs) | 19 | ~30-40 | ~38 |
| `--level=national --journees=all` (~10-20k matchs) | 20k | ~1000-2000 | ~40k |
| Full 3 niveaux `--journees=all` (~50-200k matchs) | 200k | ~5-15k | ~400k |

Durée des 2 ETL : quelques minutes même pour la volumétrie max (pas de réseau, juste SQL local).

## Pipeline state après cette feature

```
✅ clubs (listing + détail enrichi)
✅ salles
✅ competitions + phases + poules
✅ equipes + engagements
✅ matchs
✅ arbitres + match_officiels       ← cette feature
⏭ classements                       ← prochaine entité (composant competitions---classements)
⏭ stats joueurs (national uniquement, core.stats_joueurs)
⏭ résolutions FK différées (club_id sur equipes, salle_id sur matchs, club_rattachement_id sur arbitres)
```

## Future features liées

- **Résolution `club_rattachement_id` arbitres** : nécessite une source supplémentaire (page profil arbitre, non publique pour l'instant). Idem situation que `equipes.club_id`.
- **Niveau arbitre** : T1/T2/territorial/départemental — pas exposé dans `rencontre-list`. Pourrait être inféré via le niveau des compétitions où l'arbitre officie (heuristique).
- **Numéro de licence FFHB officiel** : derrière login GestHand, non scrapable publiquement.
