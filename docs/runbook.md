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

## Enrichir les clubs avec leur salle (passe `club-details`)

Cette passe est la **source principale** pour les entités `clubs` (enrichi) et `salles`.
Elle visite chaque fiche détail club sur `monclub.ffhandball.fr` et alimente
`raw.clubs` (payload enrichi) + `raw.salles` en une seule requête HTTP par club.

### Scrape

```bash
# Test dev sur 1 slug
npm run scrape -- --entity=club-details --saison=2025-2026 --slug=handball-club-de-vihiers

# Validation sur 50 clubs (les 50 premiers slugs renvoyés par la home)
npm run scrape -- --entity=club-details --saison=2025-2026 --limit=50

# Run complet (~2326 clubs, ~60 min à 1.5 s/req — préférer en nocturne)
npm run scrape -- --entity=club-details --saison=2025-2026
```

Le scraper :
1. Fetch `https://monclub.ffhandball.fr/` une fois et extrait ~2326 slugs (`parseClubSlugs`)
2. Pour chaque slug, fetch `https://monclub.ffhandball.fr/clubs/<slug>/`, parse le JSON
   embarqué dans le composant `smartfire-component[name='single-club---home-hero-club']`
3. Insère un payload enrichi dans `raw.clubs` et, si le club a une salle, un payload
   dans `raw.salles` (la natural_key salle est un slug dérivé de `name_gym + zipcode + city`)

### ETL dans l'ordre

```bash
npm run etl -- --entity=salles --saison=2025-2026
npm run etl -- --entity=clubs  --saison=2025-2026
```

**Important :** lancer `salles` **avant** `clubs`. Sinon le `salle_principale_id`
des clubs reste NULL avec un warning par club concerné. Un re-run de `clubs`
après `salles` résout les FKs manquantes (les anciens warnings restent en base
mais l'état final est correct).

### Suivre la couverture

```sql
-- % de clubs avec salle principale résolue
SELECT
  count(*)                                                AS total,
  count(salle_principale_id)                              AS with_salle,
  round(100.0 * count(salle_principale_id) / count(*), 1) AS pct
FROM core.clubs;

-- Warnings du dernier run ETL
SELECT entity, natural_key, message
  FROM core.etl_warnings
  WHERE etl_run_id = (SELECT max(id) FROM core.etl_runs);

-- Salles sans département résolu
SELECT id_ffhb, nom, ville FROM core.salles WHERE departement_id IS NULL;

-- Top 10 clubs par effectif estimé
SELECT id_ffhb, nom, effectif_estime
  FROM core.clubs
  WHERE effectif_estime IS NOT NULL
  ORDER BY effectif_estime DESC
  LIMIT 10;
```

### Rejouer après bug de nettoyage

```sql
-- Reset salles uniquement (raw intact)
UPDATE core.clubs SET salle_principale_id = NULL;
TRUNCATE core.salles CASCADE;
```

Puis ré-exécuter les deux ETL. `raw.clubs` et `raw.salles` ne sont pas touchés —
pas besoin de rescraper.

### Notes opérationnelles

- Le User-Agent identifiable est `SCRAPE_USER_AGENT` dans `.env`
- Le rate-limit nominal est 1.5 s par requête (cf. `SCRAPE_RATE_LIMIT_MS`)
- Volumétrie attendue : ~2326 fiches détail → ~60 minutes en nocturne
- ~3/8 des clubs n'ont pas de salle déclarée (gyms_club = `false`) — c'est normal
- `--limit=N` retourne toujours les N premiers slugs **par ordre alphabétique** — c'est
  pour les tests dev, pas pour les exécutions partielles "rotatives"
- Les coordonnées GPS (`latitude` / `longitude`) des salles sont **conservées dans
  `raw.salles.payload`** mais ne sont **pas propagées vers `core.salles`** (pas de
  colonnes dédiées). À faire dans une migration future si on en a besoin côté API
- Les coordonnées GPS des clubs (`latitude` / `longitude`) sont, elles, propagées
  vers `core.clubs`

## Scraper les compétitions (passe `competitions`)

Cette passe est la source unique pour les entités `competitions`, `phases`, `poules`.
Elle visite les pages liste de `ffhandball.fr/competitions/` aux 3 niveaux
(national, régional, départemental) puis chaque fiche détail de compétition
pour en extraire les phases et poules.

### Scrape

```bash
# Test dev : un seul niveau, peu de détails
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=5

# Run complet (les 3 niveaux, ~500-700 compétitions, ~25-35 min)
npm run scrape -- --entity=competitions --saison=2025-2026
```

Le scraper :
1. Fetch `https://www.ffhandball.fr/competitions/` pour résoudre `ext_saison_id`
2. Pour chaque niveau dans (national, regional, departemental) :
   - Fetch la page liste du niveau (composant `competitions---competition-main-menu`)
   - National : insère directement les ~20 compétitions
   - Régional/dép : itère sur `structures[]` (ligues/comités), fetch chaque page per-structure, insère les compétitions
3. Pour chaque compétition insérée, fetch la fiche détail (composant `competitions---poule-selector`) et insère `phases` + `poules`

### ETL dans l'ordre

```bash
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
```

**Ordre obligatoire :** `competitions` → `phases` → `poules`. Lancer `phases` avant `competitions` génère un warning par phase (FK competition non résolue) et skippe la ligne. Un re-run de `phases` après `competitions` résout les FKs manquantes (les anciens warnings restent en base mais l'état final est correct).

### Suivre la couverture

```sql
-- Compétitions par niveau et genre
SELECT niveau, sexe, count(*) FROM core.competitions GROUP BY 1,2 ORDER BY 1,2;

-- Compétitions sans phases (anomalie)
SELECT c.id_ffhb, c.nom
  FROM core.competitions c
  LEFT JOIN core.phases p ON p.competition_id = c.id
  WHERE p.id IS NULL;

-- Phases sans poules
SELECT p.id_ffhb, p.nom
  FROM core.phases p
  LEFT JOIN core.poules po ON po.phase_id = p.id
  WHERE po.id IS NULL;

-- Warnings du dernier run ETL
SELECT entity, natural_key, message
  FROM core.etl_warnings
  WHERE etl_run_id = (SELECT max(id) FROM core.etl_runs);
```

### Rejouer après bug

```sql
TRUNCATE core.poules CASCADE;
TRUNCATE core.phases CASCADE;
TRUNCATE core.competitions CASCADE;
```

Puis ré-exécuter les 3 ETL dans l'ordre. `raw.competitions`, `raw.phases`, `raw.poules` ne sont pas touchés — pas besoin de rescraper.

### Notes opérationnelles

- User-Agent identifiable (`SCRAPE_USER_AGENT`) et rate-limit 1.5 s/req (`SCRAPE_RATE_LIMIT_MS`)
- Volumétrie : ~500-700 compétitions, ~600-900 phases, ~1500-3000 poules
- ~25-35 min en nocturne pour un run complet
- `categorie_age` reste NULL pour l'instant (pas exposé explicitement par la source)
- `--limit=N` limite uniquement la passe B (détails) ; toutes les listes sont scrapées
- Si le pattern URL per-structure change côté ffhandball.fr, ajuster la construction d'URL dans `scrapeCompetitions()` (`src/cli/scrape.ts`)

### Équipes et engagements

Les équipes et engagements sont alimentés par la **même commande** `--entity=competitions`,
qui parse `competitions---calendar-button` (avec fallback `equipe_options` du
`poule-selector` si calendar-button absent). Si tu as déjà scrapé les compétitions
avant l'ajout de cette feature, **un re-run complet du scrape est nécessaire** pour
récupérer les équipes (le HTML brut n'est pas stocké en raw).

```bash
# Re-run complet pour peupler raw.equipes + raw.engagements
npm run scrape -- --entity=competitions --saison=2025-2026

# ETL — ordre complet (5 étapes désormais)
npm run etl -- --entity=competitions  --saison=2025-2026
npm run etl -- --entity=phases        --saison=2025-2026
npm run etl -- --entity=poules        --saison=2025-2026
npm run etl -- --entity=equipes       --saison=2025-2026  # ← nouveau
npm run etl -- --entity=engagements   --saison=2025-2026  # ← nouveau
```

**Important — FK `club_id` non résolue** : à ce stade, `core.equipes.club_id` est
systématiquement `NULL` (warning ETL par équipe). Le mapping `ext_structure_id`
(Smartfire) → `clubs.id_ffhb` (FFHB) n'est pas trivial — une future feature dédiée
fera la résolution (par fuzzy match nom/ville via pg_trgm, ou via une page Rosetta
si identifiée).

#### Suivre la couverture

```sql
-- % d'équipes avec club_id résolu (sera 0% jusqu'à la feature de résolution)
SELECT
  count(*)                            AS total,
  count(club_id)                      AS with_club,
  round(100.0 * count(club_id) / NULLIF(count(*), 0), 1) AS pct
FROM core.equipes;

-- Équipes par compétition (via engagements → poules → phases → competitions)
SELECT c.nom AS competition, c.niveau, count(DISTINCT en.equipe_id) AS nb_equipes
  FROM core.competitions c
  JOIN core.phases p          ON p.competition_id = c.id
  JOIN core.poules po         ON po.phase_id = p.id
  JOIN core.engagements en    ON en.poule_id = po.id
  GROUP BY c.nom, c.niveau
  ORDER BY nb_equipes DESC
  LIMIT 20;

-- Top 20 ext_structure_id par nombre d'équipes (signal pour le matching futur)
SELECT ext_structure_id, count(*), array_agg(DISTINCT nom ORDER BY nom) AS noms
  FROM core.equipes
  WHERE ext_structure_id IS NOT NULL
  GROUP BY ext_structure_id
  ORDER BY count(*) DESC
  LIMIT 20;

-- Poules sans engagements (couverture dégradée potentielle — calendar-button absent ?)
SELECT po.id_ffhb, po.nom
  FROM core.poules po
  LEFT JOIN core.engagements en ON en.poule_id = po.id
  WHERE en.poule_id IS NULL;
```

#### Rejouer après bug

```sql
TRUNCATE core.engagements;
TRUNCATE core.equipes CASCADE;  -- CASCADE car engagements référence equipes
```

Puis re-lancer `equipes` puis `engagements` ETL. `raw.equipes` / `raw.engagements` ne
sont pas touchés.

#### Notes opérationnelles

- 14 équipes / compétition Pro (LBE) ; 8-12 équipes / poule N3 ; ~5 000-10 000 équipes uniques attendues sur les 3 niveaux
- Les warnings `club_id non résolu` sont volumineux mais attendus (un par équipe par run)
- Le fallback `equipe_options` ne couvre qu'**une poule à la fois** sur une compétition multi-poules — si `calendar-button` venait à disparaître, prévoir un fetch poule-par-poule (URL avec `?ext_poule_id=...`)
