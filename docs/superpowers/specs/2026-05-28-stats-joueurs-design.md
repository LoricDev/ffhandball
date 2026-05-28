---
name: Stats joueurs (national uniquement)
description: Design de la 8ème entité — statistiques individuelles des joueurs exposées publiquement par ffhandball.fr pour les compétitions nationales
type: spec
date: 2026-05-28
---

# Stats joueurs (national)

## Contexte

Les 7 premières entités du pipeline sont livrées (clubs/salles, competitions/phases/poules, equipes/engagements, matchs, arbitres/match_officiels, classements).

L'entité `joueurs + licences` initialement prévue a été reportée : les identités complètes (numéro de licence FFHB, date de naissance, sexe, nationalité, club_rattachement) sont **derrière login GestHand** et inaccessibles publiquement (RGPD).

**Cette spec couvre une entité alternative et publique** : les **statistiques individuelles** des joueurs exposées par ffhandball.fr **pour les compétitions nationales uniquement**. Source : composant `competitions---stats-joueurs` sur `{detail_url}poule-{ext_poule_id}/statistiques/`.

Cette feature crée une **nouvelle table `core.stats_joueurs`** (pas la table `core.joueurs` existante qui reste inutilisable).

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- Créer `core.stats_joueurs` (nouvelle table) — PK (`poule_id`, `individu_id`)
- Alimenter les stats publiques (`nom`, `prenom`, `match_count`, `total_buts`, `total_arrets`) pour toutes les poules **nationales** qui exposent l'onglet "Statistiques"
- Résolution FK `equipe_id` par **match exact strict** sur `core.equipes.nom = equipe_libelle` (saison ciblée) ; nullable + warning si pas de match
- Détecter les **soft-404** (`page-header.is404=true`) pour skipper proprement les compétitions non-nationales sans erreur
- Idempotence : un re-run met à jour les stats et bouge `capture_date`
- Scope **national strict** : le scraper filtre `core.competitions.niveau='national'` en amont pour éviter ~95% des fetches inutiles (régional + dép retournent soft-404)

## Non-objectifs

- Pas d'enrichissement avec données licenciées (DDN, sexe, nationalité, numéro de licence) — derrière login GestHand
- Pas de scraping régional/départemental (composant non exposé)
- Pas de poste/position joueur (non exposé par la source)
- Pas de buts/match calculés (à dériver côté API : `total_buts / match_count`)
- Pas de gestion `core.joueurs` (table existante mais inadaptée — restera vide)
- Pas de résolution `club_rattachement_id` (idem arbitres : pas d'info publique)

## Architecture

```
core.competitions JOIN phases JOIN poules  (filtre niveau='national')
        │
        ▼ Pour chaque poule nationale :
        │
fetch {detail_url}poule-{ext_poule_id}/statistiques/
        │
        ▼
parseStatsJoueurs(html, sourceUrl, extPouleId) :
  - Détecte soft-404 via competitions---page-header.is404=true → retourne []
  - Cible competitions---stats-joueurs → data.rowsData[]
  - Pour chaque ligne : construit RawStatsJoueurPayload (coercion strings → numbers)
  - Retour : RawStatsJoueurPayload[]
        │
        ▼
raw.stats_joueurs (natural_key composite = "${ext_poule_id}-${individu_id}")
        │
        ▼
stats_joueurs.etl → core.stats_joueurs :
  - Résolution FK : poule_id (strict) + equipe_id (match exact sur equipe_libelle, fallback NULL+warning)
  - UPSERT par (poule_id, individu_id) PK composite
  - capture_date = now() à chaque run
```

**Nouvelle commande CLI** : `npm run scrape -- --entity=stats-joueurs --saison=<S> [--limit=N]`

⚠️ **Pas d'option `--level`** — par design, seul `national` est valide (les autres niveaux retournent soft-404). Le scraper filtre automatiquement.

**Ordre ETL final** : `competitions → phases → poules → equipes → engagements → matchs → arbitres → match_officiels → classements → stats_joueurs`

## Composants

### Nouveaux fichiers

- `src/schemas/stats-joueur.schema.ts` — schéma Zod `raw.stats_joueurs`
- `src/scrapers/ffhandball/stats-joueurs.scraper.ts` — `parseStatsJoueurs(html, sourceUrl, extPouleId)`
- `src/etl/stats-joueurs.etl.ts` — pipeline `raw.stats_joueurs → core.stats_joueurs`
- `db/migrations/0013_stats_joueurs.sql` — CREATE TABLE `core.stats_joueurs` + raw via `_create_capture_table`
- `tests/fixtures/ffhandball-poule-stats-lbe.html` (fixture national avec 287 joueurs)
- `tests/schemas/stats-joueur.schema.test.ts`
- `tests/scrapers/stats-joueurs.scraper.test.ts`
- `tests/etl/stats-joueurs.etl.test.ts`
- `tests/integration/stats-joueurs-end-to-end.test.ts`

### Fichiers modifiés

- `src/cli/scrape.ts` — handler `scrapeStatsJoueurs` + dispatch sur `--entity=stats-joueurs`
- `src/cli/etl.ts` — accepter `--entity=stats-joueurs`
- `docs/runbook.md` — nouvelle section "Scraper les stats joueurs"

## Source de données

### Composant : `competitions---stats-joueurs`

URL : `{detail_url}poule-{ext_poule_id}/statistiques/`

Exemple JSON complet (meilleur buteur LBE) :

```json
{
  "individuId": "3098815",
  "matchCount": "25",
  "totalButs": "195",
  "totalArrets": "0",
  "nom": "ANTONISSEN",
  "prenom": "NELE",
  "showEquipeLogo": "1",
  "equipeLibelle": "HANDBALL PLAN DE CUQUES",
  "structureLogo": "2017-08-21-...jpg"
}
```

**Champs utiles** :
- `individuId` (natural key joueur, ID FFHB anonymisé)
- `nom`, `prenom`
- `matchCount`, `totalButs`, `totalArrets`
- `equipeLibelle` (pour résoudre FK `equipe_id`)

**Ignorés** : `showEquipeLogo`, `structureLogo`.

### Détection soft-404

Sur les niveaux régional/départemental, l'URL `/statistiques/` retourne HTTP 200 mais avec un signal dans `competitions---page-header.attributes.is404=true` (et `title="Page not found - FFHandball"`).

**Le scraper doit détecter ce signal** et retourner `[]` proprement (pas d'erreur, pas de warning).

### Index `equipe_options` ?

Le composant `equipe_options` du `poule-selector` **n'est pas requis** ici car la source expose déjà `equipeLibelle` directement (texte). On résout via match strict côté ETL, pas via index côté scraper.

## Schéma Zod

### `raw.stats_joueurs.payload`

```ts
const intFromStringOrNumber = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  },
  z.number().int().nonnegative(),
);

export const rawStatsJoueurPayloadSchema = z.object({
  ext_poule_id: z.string().min(1),
  individu_id: z.string().min(1),         // "3098815"
  nom: z.string().min(1),
  prenom: z.string().min(1),
  equipe_libelle: z.string().min(1),
  match_count: intFromStringOrNumber,
  total_buts: intFromStringOrNumber,
  total_arrets: intFromStringOrNumber,
  source_url: z.string().url(),
});
export type RawStatsJoueurPayload = z.infer<typeof rawStatsJoueurPayloadSchema>;
```

**natural_key composite** : `${ext_poule_id}-${individu_id}` (un joueur peut apparaître dans plusieurs poules si plusieurs compétitions nationales).

## Migration `0013_stats_joueurs.sql`

```sql
-- 1. Raw table via helper
SELECT raw._create_capture_table('stats_joueurs');

-- 2. core.stats_joueurs (nouvelle table)
CREATE TABLE IF NOT EXISTS core.stats_joueurs (
  id             bigserial PRIMARY KEY,
  poule_id       bigint NOT NULL REFERENCES core.poules(id) ON DELETE CASCADE,
  individu_id    text NOT NULL,
  nom            text NOT NULL,
  prenom         text NOT NULL,
  equipe_id      bigint REFERENCES core.equipes(id),
  equipe_libelle text NOT NULL,
  match_count    integer NOT NULL DEFAULT 0,
  total_buts     integer NOT NULL DEFAULT 0,
  total_arrets   integer NOT NULL DEFAULT 0,
  saison_code    text NOT NULL REFERENCES core.saisons(saison_code),
  capture_date   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_stats_joueurs_poule_individu UNIQUE (poule_id, individu_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_joueurs_poule       ON core.stats_joueurs (poule_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_equipe      ON core.stats_joueurs (equipe_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_individu    ON core.stats_joueurs (individu_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_total_buts  ON core.stats_joueurs (total_buts DESC) WHERE total_buts > 0;
```

## Logique scraper

### `parseStatsJoueurs(html, sourceUrl, extPouleId): RawStatsJoueurPayload[]`

```ts
export function parseStatsJoueurs(html, sourceUrl, extPouleId) {
  const $ = cheerio.load(html);

  // 1. Détecter soft-404 via page-header
  const header = loadAttributes($, "competitions---page-header") as { is404?: boolean } | null;
  if (header?.is404 === true) return [];

  // 2. Parser stats-joueurs
  const data = loadAttributes($, "competitions---stats-joueurs") as
    | { rowsData?: Array<Record<string, unknown>> }
    | null;
  if (!data?.rowsData) return [];

  const result: RawStatsJoueurPayload[] = [];
  for (const row of data.rowsData) {
    const candidate = {
      ext_poule_id: extPouleId,
      individu_id: row.individuId,
      nom: row.nom,
      prenom: row.prenom,
      equipe_libelle: row.equipeLibelle,
      match_count: row.matchCount,
      total_buts: row.totalButs,
      total_arrets: row.totalArrets,
      source_url: sourceUrl,
    };
    const parsed = rawStatsJoueurPayloadSchema.safeParse(candidate);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
```

**Retour systématiquement `[]` ou tableau non-vide** — pas de `null` pour ce parser (différent de `classement` et `rencontre-list` qui ont des cas `null`). Raison : on a 2 signaux clairs (soft-404 ou rowsData) qui couvrent tous les cas.

### Handler CLI `scrapeStatsJoueurs(saison, opts)`

```ts
async function scrapeStatsJoueurs(saison, opts: { limit? }) {
  const run = await startScrapeRun({ source_site: "ffhandball.fr", scraper_name: "stats-joueurs", saison });

  try {
    // Filtre niveau='national' (gain de ~95% des fetches)
    const poulesRes = await query(`
      SELECT po.id_ffhb AS ext_poule_id, c.detail_url
        FROM core.poules po
        JOIN core.phases ph       ON ph.id = po.phase_id
        JOIN core.competitions c  ON c.id = ph.competition_id
        WHERE po.saison_code = $1
          AND c.niveau = 'national'
          AND c.detail_url IS NOT NULL
        ORDER BY c.id_ffhb, po.id_ffhb
    `, [saison]);

    let poules = poulesRes.rows;
    if (opts.limit !== undefined) poules = poules.slice(0, opts.limit);

    let totalInserted = 0;
    let pouleSansStats = 0;
    for (const po of poules) {
      const url = `${po.detail_url}poule-${po.ext_poule_id}/statistiques/`;
      const res = await fetchHtml(url);
      await run.incrementPages(1);
      if (res.status >= 400) continue;

      const parsed = parseStatsJoueurs(res.body, url, po.ext_poule_id);
      if (parsed.length === 0) { pouleSansStats++; continue; }

      for (const s of parsed) {
        await insertRaw("stats_joueurs", {
          scrape_run_id: run.id,
          source_url: s.source_url,
          source_site: "ffhandball.fr",
          natural_key: `${s.ext_poule_id}-${s.individu_id}`,
          payload: s,
          saison,
          http_status: res.status,
        });
        totalInserted++;
      }
    }
    logger.info({ totalInserted, pouleSansStats, totalPoules: poules.length }, "stats-joueurs done");
    await run.finishSuccess();
  } catch (err) {
    await run.finishFailure(err); throw err;
  }
}
```

## Logique ETL — `runStatsJoueursEtl(saison)`

1. INSERT `core.etl_runs(entity='stats_joueurs')`
2. SELECT DISTINCT ON (natural_key) depuis `raw.stats_joueurs WHERE saison = $1`
3. Pour chaque ligne :
   - Zod validate → reject → `core.etl_rejets`
   - Résoudre `poule_id` via `core.poules.id_ffhb` (strict) → warning + skip si null
   - Résoudre `equipe_id` via `SELECT id FROM core.equipes WHERE nom = $1 AND saison_code = $2 LIMIT 1` :
     - Match unique → assigne
     - Pas de match → `equipe_id = NULL` + warning (faible, on conserve `equipe_libelle`)
     - Match ambigu (>1 résultat) : on prend le 1er (rare car saison-scopé)
   - UPSERT `core.stats_joueurs (poule_id, individu_id, nom, prenom, equipe_id, equipe_libelle, match_count, total_buts, total_arrets, saison_code, capture_date)` par `(poule_id, individu_id)` PK composite :
     - INSERT initial avec `capture_date = now()`
     - ON CONFLICT : UPDATE nom, prenom, equipe_id (COALESCE), equipe_libelle, match_count, total_buts, total_arrets, `capture_date = now()`
4. UPDATE `core.etl_runs` final (success/failed)

## CLI

```bash
# Dev — 3 poules nationales
npm run scrape -- --entity=stats-joueurs --saison=2025-2026 --limit=3

# Run complet national (~50-100 poules, ~2-3 min)
npm run scrape -- --entity=stats-joueurs --saison=2025-2026

# ETL
npm run etl -- --entity=stats-joueurs --saison=2025-2026
```

## Tests

### Fixtures à capturer (T1)

- `ffhandball-poule-stats-lbe.html` : LBE poule 168256, 287 joueurs nationaux

(Le cas soft-404 sera testé via HTML synthétique inline, pas besoin de fixture dédiée.)

### Unitaires schéma (5 tests)

- Accepts complete payload with strings (coercion vers numbers)
- Accepts payload with numbers directly
- Rejects empty individu_id
- Rejects empty equipe_libelle
- Rejects when match_count is malformed

### Unitaires scraper (5 tests)

- Extracts 287 stats from LBE fixture
- Returns [] on soft-404 (HTML synthétique avec is404=true)
- Returns [] when stats-joueurs component is absent
- Returns [] when rowsData is empty
- Coercion : tous les ints sont bien des numbers

### Unitaires ETL (8 tests)

- Insert nominal : FK poule résolue, FK equipe résolue via match nom exact, tous champs propagés, capture_date populé
- FK poule non résolue → warning + skip
- FK equipe non résolue (equipe_libelle inexistant en core.equipes) → equipe_id NULL + warning
- Rejet Zod (payload invalide)
- Idempotence (re-run → 1 ligne par PK)
- Update : stats changent entre runs → values mises à jour, capture_date bumped
- Plusieurs joueurs d'une même poule (full ranking insert)
- Match équipe : ambigu (2 équipes même nom différentes saisons) — confirme filtre `saison_code`
- `afterAll(closePool)` à la fin

### Intégration end-to-end (2 tests)

- Setup competition + phase + poule + 1 équipe
- Parse fixture LBE → insertRaw → run ETL → assert 287 lignes core, équipes résolues vs non-résolues (warnings expected)
- Idempotence

## Cas dégradés

| Cas | Comportement |
|---|---|
| Régional/Dép `/statistiques/` (soft-404) | Scraper retourne `[]`, log debug, pas de warning |
| `competitions---stats-joueurs` absent (cas exceptionnel sur national) | Scraper retourne `[]` |
| `rowsData = []` (compétition sans matchs joués) | Scraper retourne `[]`, log info |
| Champ `individuId` ou nom/prenom manquant | Zod reject ligne, push en `core.etl_rejets` |
| Equipe `libellé` introuvable en `core.equipes` (cas variations orthographe) | `equipe_id = NULL` + warning ETL |
| Re-run après mise à jour stats source (transitions journées) | UPSERT met à jour stats + capture_date |
| Joueur changeant d'équipe en cours de saison | Re-scrape ajoute une nouvelle ligne (poule_id différente) ; pas de conflit avec PK composite |
| `--limit` plus grand que le nb de poules nationales | OK, traite toutes les disponibles |

## Volumétrie attendue

| Mode | Poules nationales | Temps | Lignes |
|---|---|---|---|
| `--limit=3` | 3 | 5s | ~600-900 |
| Run complet national | ~50-100 | 2-3 min | ~15-30k |

Très rapide vs matchs `--journees=all` (17-33h). Bonne candidate pour un re-run quotidien (cf. `docs/DEPLOY.md`).

## Pipeline state après cette feature

```
✅ clubs (listing + détail enrichi)
✅ salles
✅ competitions + phases + poules
✅ equipes + engagements
✅ matchs
✅ arbitres + match_officiels
✅ classements
✅ stats_joueurs (national)         ← cette feature
⏭ Résolutions FK différées (club_id↔equipes, salle_id↔matchs, club_rattachement_id↔arbitres)
```

**Statut pipeline : 8 entités sur 8 entités scrapables publiquement livrées.** Les entités restantes du schéma d'origine (`joueurs`/`licences`) sont bloquées par accès login GestHand — non livrables sans authentification.

## Future feature liée

- **Vue cross-poule** : top buteurs nationaux toutes compétitions confondues (`SUM(total_buts) GROUP BY individu_id`) — vue SQL côté API, pas d'ETL
- **Buts par match** : colonne dérivée (`total_buts / NULLIF(match_count, 0)`) — vue SQL
- **Évolution temporelle** : historique journée-par-journée si besoin (similar à classements_snapshots envisagé)
