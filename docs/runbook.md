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

## Scraper les matchs (rencontres)

Cette passe alimente `core.matchs` à partir du composant `competitions---rencontre-list`
exposé sur chaque page poule de `ffhandball.fr`. Lit `core.poules` (JOIN phases JOIN
competitions) pour itérer.

### Scrape

```bash
# Dev — 5 poules nationales, journée courante
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --limit=5

# Journée courante 3 niveaux (~1500-3000 req, ~1h)
npm run scrape -- --entity=matchs --saison=2025-2026

# Toutes journées nationales (~1300-2600 req, ~30-65 min)
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --journees=all

# Run complet 3 niveaux toutes journées (~40-80k req, 17-33h sur plusieurs nuits)
npm run scrape -- --entity=matchs --saison=2025-2026 --journees=all
```

**Modes journées :**
- `--journees=courante` (défaut) : 1 requête par poule, journée actuelle uniquement. Cible : mise à jour quotidienne des scores.
- `--journees=all` : itération sur toutes les journées (typiquement 26 par poule en championnat régulier). Cible : initialisation complète + rattrapage rétrospectif.

### ETL

```bash
npm run etl -- --entity=matchs --saison=2025-2026
```

**Ordre obligatoire global** : `competitions → phases → poules → equipes → engagements → matchs`.

### Suivre la couverture

```sql
-- Comptes par statut
SELECT statut, count(*) FROM core.matchs GROUP BY statut;

-- Matchs par niveau (via poule → phase → compétition)
SELECT c.niveau, count(m.*) AS nb_matchs, count(m.*) FILTER (WHERE m.statut='joue') AS joues
  FROM core.matchs m
  JOIN core.poules po       ON po.id = m.poule_id
  JOIN core.phases ph       ON ph.id = po.phase_id
  JOIN core.competitions c  ON c.id = ph.competition_id
  GROUP BY c.niveau
  ORDER BY c.niveau;

-- Matchs sans equipement_id (couverture sources salle)
SELECT count(*) FROM core.matchs WHERE equipement_id IS NULL;

-- Top 20 equipement_id par fréquence (signal future feature résolution salle)
SELECT equipement_id, count(*) FROM core.matchs
  WHERE equipement_id IS NOT NULL
  GROUP BY equipement_id ORDER BY count(*) DESC LIMIT 20;

-- Warnings ETL matchs
SELECT message, count(*) FROM core.etl_warnings
  WHERE entity='matchs' AND etl_run_id = (SELECT max(id) FROM core.etl_runs WHERE entity='matchs')
  GROUP BY message ORDER BY count(*) DESC;

-- Couverture journées : nombre de journées scrapées par poule
SELECT po.id_ffhb, count(DISTINCT m.journee) AS journees_scrapees
  FROM core.poules po
  LEFT JOIN core.matchs m ON m.poule_id = po.id
  GROUP BY po.id_ffhb
  ORDER BY journees_scrapees DESC NULLS LAST
  LIMIT 20;
```

### Rejouer après bug

```sql
TRUNCATE core.matchs CASCADE;
```

Puis re-lancer `etl --entity=matchs`. `raw.matchs` n'est pas touché.

### Notes opérationnelles

- Mode `--journees=all` 3 niveaux : **prévoir en nocturne sur plusieurs nuits** (17-33h à 1.5s/req)
- `core.matchs.salle_id` reste **NULL** pour cette feature. `equipement_id` est stocké pour permettre une future résolution
- Statuts `reporte`/`annule`/`forfait` **ne sont pas détectables** depuis cette source. Tous les matchs sont en `a_jouer` ou `joue`
- Les arbitres (`arbitre1_id`, `arbitre2_id`, etc.) sont stockés dans `raw.matchs.payload` — une future feature alimentera `core.arbitres` + `core.match_officiels` sans re-scrape
- En re-scrape (mise à jour quotidienne des scores), un match qui passe de `a_jouer → joue` met à jour `updated_at`
- `--limit=N` limite le **nombre de poules** scrapées (pas le nombre de matchs)

## ETL arbitres et match_officiels

Pas de scraping nouveau. Les arbitres sont extraits depuis `raw.matchs.payload`
(champs `arbitre1_id/nom` et `arbitre2_id/nom` capturés lors du scrape des matchs).
2 ETLs en cascade alimentent `core.arbitres` puis `core.match_officiels`.

### ETL — ordre obligatoire

```bash
# Pré-requis : raw.matchs déjà peuplée (cf. section "Scraper les matchs")

npm run etl -- --entity=arbitres        --saison=2025-2026
npm run etl -- --entity=match_officiels --saison=2025-2026
```

L'ordre `arbitres → match_officiels` est obligatoire (le second résout FK vers `core.arbitres`).

### Suivre la couverture

```sql
-- Comptes
SELECT 'arbitres' AS t, count(*) FROM core.arbitres
UNION ALL SELECT 'avec_prenom', count(prenom) FROM core.arbitres
UNION ALL SELECT 'match_officiels', count(*) FROM core.match_officiels;

-- Top 20 arbitres par nombre de matchs officiés
SELECT a.id_ffhb, a.nom, a.prenom, count(*) AS nb_matchs
  FROM core.match_officiels mo
  JOIN core.arbitres a ON a.id = mo.arbitre_id
  GROUP BY a.id, a.id_ffhb, a.nom, a.prenom
  ORDER BY nb_matchs DESC LIMIT 20;

-- Répartition par rôle
SELECT role, count(*) FROM core.match_officiels GROUP BY role;

-- Matchs sans arbitre (pas attendu, sauf si arbitre1/2 manquaient en source)
SELECT count(*) FROM core.matchs m
  WHERE NOT EXISTS (
    SELECT 1 FROM core.match_officiels mo WHERE mo.match_id = m.id
  );

-- Warnings ETL
SELECT entity, message, count(*) FROM core.etl_warnings
  WHERE entity IN ('arbitres', 'match_officiels')
    AND etl_run_id >= (SELECT max(id)-1 FROM core.etl_runs WHERE entity = 'arbitres')
  GROUP BY entity, message ORDER BY count(*) DESC;
```

### Rejouer après bug

```sql
TRUNCATE core.match_officiels;
TRUNCATE core.arbitres CASCADE;
```

Puis re-lancer les 2 ETLs dans l'ordre. `raw.matchs` n'est pas touché.

### Notes opérationnelles

- Le `nom_complet` brut est conservé pour permettre une future réconciliation (split imparfait sur ~5% des cas : noms composés, particules)
- `numero_licence` reste **NULL** (pas exposé publiquement par ffhandball.fr — derrière login GestHand)
- `club_rattachement_id` reste **NULL** (pas exposé non plus)
- `niveau` reste **NULL** (T1/T2/territorial/départemental non exposés)
- Volumétrie attendue après scrape complet matchs : ~5-15k arbitres uniques, ~100-400k lignes match_officiels
- Si un re-scrape matchs ajoute des arbitres jamais vus, ré-exécuter `arbitres` puis `match_officiels` ETL

## Scraper les classements (table des poules)

Alimente `core.classements` (snapshot du classement par poule) depuis le composant
`competitions---classement`. Pattern identique aux matchs (lit `core.poules` JOIN
phases JOIN competitions), mais 1 seul fetch par poule (pas d'iteration journées).

### Scrape

```bash
# Dev — 5 poules nationales
npm run scrape -- --entity=classements --saison=2025-2026 --level=national --limit=5

# Toutes les poules nationales (~50-100 poules, ~2-3 min)
npm run scrape -- --entity=classements --saison=2025-2026 --level=national

# Run complet 3 niveaux (~5000 poules, ~2h à 1.5 s/req)
npm run scrape -- --entity=classements --saison=2025-2026
```

### ETL

```bash
npm run etl -- --entity=classements --saison=2025-2026
```

**Ordre obligatoire global** : `competitions → phases → poules → equipes →
engagements → matchs → arbitres → match_officiels → classements`.

### Suivre la couverture

```sql
-- Counts
SELECT 'classements' AS t, count(*) FROM core.classements
UNION ALL SELECT 'avec_dernieres_rencontres', count(dernieres_rencontres) FROM core.classements
UNION ALL SELECT 'poules_avec_classement', count(DISTINCT poule_id) FROM core.classements;

-- Poules sans classement (compétitions sans matchs joués, normal en début de saison)
SELECT po.id_ffhb, po.nom
  FROM core.poules po
  LEFT JOIN core.classements cl ON cl.poule_id = po.id
  WHERE cl.poule_id IS NULL
  LIMIT 20;

-- Top buteurs par poule (équipes ayant le plus de buts pour, par compétition)
SELECT c.nom AS competition, po.nom AS poule,
       e.nom AS equipe, cl.points, cl.buts_pour, cl.difference
  FROM core.classements cl
  JOIN core.poules po       ON po.id = cl.poule_id
  JOIN core.phases ph       ON ph.id = po.phase_id
  JOIN core.competitions c  ON c.id = ph.competition_id
  JOIN core.equipes e       ON e.id = cl.equipe_id
  WHERE cl.position = 1
  ORDER BY c.niveau, cl.buts_pour DESC
  LIMIT 50;

-- Fraîcheur des snapshots (combien de classements sont "récents")
SELECT
  count(*) FILTER (WHERE capture_date > now() - interval '24 hours') AS recents,
  count(*) FILTER (WHERE capture_date <= now() - interval '24 hours') AS anciens,
  max(capture_date) AS dernier_run
FROM core.classements;

-- Warnings ETL classements
SELECT message, count(*) FROM core.etl_warnings
  WHERE entity='classements'
    AND etl_run_id = (SELECT max(id) FROM core.etl_runs WHERE entity='classements')
  GROUP BY message ORDER BY count(*) DESC;
```

### Rejouer après bug

```sql
TRUNCATE core.classements;
```

Puis re-lancer `etl --entity=classements`. `raw.classements` n'est pas touché.

### Notes opérationnelles

- **1 seul fetch par poule** (pas de --journees=all comme matchs) — bien plus rapide
- `dernieres_rencontres` stocké tel quel en string (`"-1;1;1;1;1"`). Le parsing en array est délégué à l'API future
- `difference` est une colonne GENERATED (toujours = `buts_pour - buts_contre`)
- `capture_date` = timestamp du dernier ETL run pour chaque ligne (utile pour savoir si le snapshot est frais)
- Un classement peut être vide (`classements: []`) en début de saison — log info, pas warning
- Re-run quotidien recommandé (cron, cf. `docs/DEPLOY.md`) pour maintenir `capture_date` frais

## Scraper les stats joueurs (national + régional séniors)

Alimente `core.stats_joueurs` depuis le composant `competitions---stats-joueurs`.
**Scope : compétitions nationales + régionales séniors** (N3, Prénationale,
Excellence, Honneur, 1ère Div...). Le flag source `afficherStatsJoueurs="1"` dans
les attributs de `competitions---competition-main-menu` détermine quelles
compétitions exposent les stats. Régional jeunes et départemental = `"0"`.

Le flag est stocké dans `core.competitions.afficher_stats_joueurs` (BOOLEAN) et
sert de filtre dans la requête stats-joueurs. **Prérequis : avoir re-scrappé les
compétitions** pour remplir ce flag (cf. dépendance ci-dessous).

### Données disponibles publiquement

- `individu_id` (ID FFHB du joueur, anonymisé côté public)
- `nom`, `prenom`
- `match_count`, `total_buts`, `total_arrets`
- `equipe_libelle` (résolu en `equipe_id` via match exact côté ETL, sinon NULL)

**Ce qu'on n'a PAS** : date de naissance, sexe, nationalité, numéro de licence,
poste/position joueur — derrière login GestHand (RGPD).

### Scrape

```bash
# Dev — 20 poules (nationales + régionales selon ordre c.id_ffhb)
npm run scrape -- --entity=stats-joueurs --saison=2025-2026 --limit=20

# Run complet national + régional séniors (~500-1000 poules, ~15-30 min)
npm run scrape -- --entity=stats-joueurs --saison=2025-2026
```

Pas d'option `--level` — le filtre `afficher_stats_joueurs=true` est appliqué en
amont et couvre tous les niveaux concernés (national + régional séniors).

### ETL

```bash
npm run etl -- --entity=stats-joueurs --saison=2025-2026
```

**Ordre obligatoire global** : `competitions → phases → poules → equipes →
engagements → matchs → arbitres → match_officiels → classements → stats-joueurs`.

**Important** : si `core.competitions.afficher_stats_joueurs` est NULL pour les
compétitions régionales, relancer d'abord :
```bash
npm run scrape -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=competitions --saison=2025-2026
```

### Suivre la couverture

```sql
-- Counts global + par niveau
SELECT 'stats_joueurs_total' AS t, count(*) FROM core.stats_joueurs
UNION ALL SELECT 'equipe_id_resolu', count(equipe_id) FROM core.stats_joueurs
UNION ALL SELECT 'taux_resolution_pct',
       (count(equipe_id) * 100 / NULLIF(count(*), 0))::text::int FROM core.stats_joueurs;

-- Distribution par niveau de compétition
SELECT c.niveau, count(*) AS stats_count
  FROM core.stats_joueurs s
  JOIN core.poules po ON po.id = s.poule_id
  JOIN core.phases ph ON ph.id = po.phase_id
  JOIN core.competitions c ON c.id = ph.competition_id
 GROUP BY c.niveau ORDER BY c.niveau;

-- Couverture flag afficher_stats_joueurs par niveau
SELECT niveau,
       count(*) FILTER (WHERE afficher_stats_joueurs = true) AS avec_stats,
       count(*) FILTER (WHERE afficher_stats_joueurs = false) AS sans_stats,
       count(*) FILTER (WHERE afficher_stats_joueurs IS NULL) AS null_flag,
       count(*) AS total
  FROM core.competitions GROUP BY niveau ORDER BY niveau;

-- Top 20 buteurs toutes compétitions confondues
SELECT s.nom, s.prenom, s.equipe_libelle, s.total_buts, s.match_count,
       round(s.total_buts::numeric / NULLIF(s.match_count, 0), 2) AS buts_par_match
  FROM core.stats_joueurs s
  ORDER BY s.total_buts DESC LIMIT 20;

-- Top 20 gardiens (arrêts)
SELECT s.nom, s.prenom, s.equipe_libelle, s.total_arrets, s.match_count
  FROM core.stats_joueurs s
  WHERE s.total_arrets > 0
  ORDER BY s.total_arrets DESC LIMIT 20;

-- Distribution warnings (équipes non résolues)
SELECT message, count(*) FROM core.etl_warnings
  WHERE entity='stats_joueurs'
    AND etl_run_id = (SELECT max(id) FROM core.etl_runs WHERE entity='stats_joueurs')
  GROUP BY message ORDER BY count(*) DESC LIMIT 20;

-- Fraîcheur des snapshots
SELECT
  count(*) FILTER (WHERE capture_date > now() - interval '24 hours') AS recents,
  max(capture_date) AS dernier_run
FROM core.stats_joueurs;
```

### Rejouer après bug

```sql
TRUNCATE core.stats_joueurs;
```

Puis re-lancer `etl --entity=stats-joueurs`. `raw.stats_joueurs` n'est pas touché.

### Notes opérationnelles

- **Scope étendu** : national (~20 compétitions) + régional séniors (~190-340
  compétitions selon les 19 ligues). Le filtre `afficher_stats_joueurs=true`
  exclut automatiquement le régional jeunes et le départemental (flag=false)
- **Dépendance flag** : le champ `afficher_stats_joueurs` est rempli lors du
  scrape des compétitions. Si NULL pour le régional, re-scrapper les compétitions
  avant de lancer stats-joueurs
- `core.joueurs` (table FFHB officielle) reste **vide** — les identités complètes
  nécessiteraient un accès GestHand authentifié
- L'`equipe_libelle` est conservé en clair même quand `equipe_id` est NULL
- Volumétrie totale : **~30-100k lignes** (~250-350 compétitions × ~3-12
  équipes × ~12 joueurs), vs ~15-30k national-only
- Re-run quotidien possible via cron (cf. `docs/DEPLOY.md`) — plus coûteux
  qu'avant (~15-30 min au lieu de ~2-3 min)

---

## Scraper les feuilles de match (FdM PDFs)

Télécharge et parse les feuilles de match officielles FFHandball au format PDF
depuis `media-ffhb-fdm.ffhandball.fr`. Alimente `core.joueurs` (vide
auparavant), enrichit `core.match_compositions`, peuple `core.match_actions`
(déroulé chronologique).

### Pré-requis

- `raw.matchs` doit contenir des `fdm_code` (champ exposé par `rencontre-list`
  lors du scrape matchs)
- Migration 0015 appliquée (ajoute `core.matchs.fdm_code` + `fdm_url`)
- ETL matchs étendu pour propager `fdm_code` vers core

### Scrape

```bash
# Dev — 5 FdMs (test)
npm run scrape -- --entity=feuilles-match --saison=2025-2026 --limit=5

# Run complet (~50-200k FdMs, 30-100h selon scope matchs, MULTI-NUITS)
npm run scrape -- --entity=feuilles-match --saison=2025-2026
```

Le scraper :
1. SELECT codes uniques depuis `raw.matchs.payload->>'fdm_code'`
2. Filtre ceux déjà en `raw.feuilles_match` (idempotence sans re-download)
3. Pour chaque code : télécharge `https://media-ffhb-fdm.ffhandball.fr/fdm/{c1}/{c2}/{c3}/{c4}/{code}.pdf`
4. Parse via `pdf-parse` v2 (page 1 metadata + officiels + compositions, page 2 déroulé)
5. insertRaw avec payload JSONB structuré (pas de PDF brut conservé)

Skip silencieux sur HTTP 404 (FdM pas encore publiée).

### ETL

```bash
npm run etl -- --entity=feuilles-match --saison=2025-2026
```

Cascade transactionnelle par FdM :
1. UPDATE `core.matchs.fdm_url`
2. UPSERT `core.joueurs` (par numero_licence)
3. UPSERT `core.match_compositions` (par match × joueur)
4. UPSERT `core.match_actions` (par match × ordre)

ROLLBACK si erreur dans la cascade. Idempotent.

### Suivre la couverture

```sql
-- FdMs téléchargées
SELECT count(*) FROM raw.feuilles_match WHERE saison = '2025-2026';

-- Matchs avec FdM disponible
SELECT
  count(*) FILTER (WHERE fdm_code IS NOT NULL) AS matchs_avec_fdm_code,
  count(*) FILTER (WHERE fdm_url IS NOT NULL) AS matchs_avec_fdm_parse,
  count(*) AS total_matchs
FROM core.matchs;

-- Top buteurs cross-FdM (cumulé sur tous les matchs analysés)
SELECT j.nom, j.prenom, SUM(mc.but_count) AS total_buts,
       COUNT(DISTINCT mc.match_id) AS matchs_joues
  FROM core.match_compositions mc
  JOIN core.joueurs j ON j.id = mc.joueur_id
  GROUP BY j.id, j.nom, j.prenom
  HAVING SUM(mc.but_count) > 0
  ORDER BY total_buts DESC LIMIT 20;

-- Sanctions cumulées
SELECT j.nom, j.prenom,
       count(*) FILTER (WHERE mc.avertissement) AS avertissements,
       sum(mc.exclusion_2min_count) AS exclusions_2min,
       count(*) FILTER (WHERE mc.disqualifie) AS disqualifications
  FROM core.match_compositions mc
  JOIN core.joueurs j ON j.id = mc.joueur_id
  GROUP BY j.id, j.nom, j.prenom
  HAVING count(*) FILTER (WHERE mc.avertissement) > 0
      OR sum(mc.exclusion_2min_count) > 0
  ORDER BY exclusions_2min DESC, avertissements DESC LIMIT 20;

-- Actions par type (vérification volumétrie)
SELECT type_action, count(*)
  FROM core.match_actions
  GROUP BY type_action ORDER BY count(*) DESC;

-- Warnings ETL
SELECT message, count(*)
  FROM core.etl_warnings
  WHERE entity = 'feuilles_match'
    AND etl_run_id = (SELECT max(id) FROM core.etl_runs WHERE entity = 'feuilles_match')
  GROUP BY message ORDER BY count(*) DESC LIMIT 20;
```

### Rejouer après bug

```sql
TRUNCATE core.match_actions;
TRUNCATE core.match_compositions CASCADE;
TRUNCATE core.joueurs CASCADE;
UPDATE core.matchs SET fdm_url = NULL;
```

Puis re-lancer `etl --entity=feuilles-match`. `raw.feuilles_match` n'est pas touché.

### Notes opérationnelles

- **Volumétrie démentielle attendue** : ~150k FdMs full run = ~45 GB téléchargements, ~80h en nocturne multi-nuits
- Idempotence stricte : ne re-download pas les FdMs déjà en `raw.feuilles_match`
- Skip silencieux sur HTTP 404 (FdM pas encore publiée pour matchs futurs)
- **RGPD** : `core.joueurs` contient n° licence + nom + prénom (publiés par FFH elle-même sur les FdMs publiques). DDN/sexe/nationalité non exposés (restent NULL)
- L'`fdm_url` peuplée dans `core.matchs` permet de servir le lien PDF directement côté API
- Heuristique gardien (basée sur `arrets > 0`) peu fiable — privilégier `core.match_actions` filtré sur type='arret' pour analyses précises

## API HTTP publique

API REST read-only basée sur Hono. Documentation auto via Swagger UI.

### Démarrage

```bash
# Production
npm run api
# → http://localhost:3000 (config via .env API_PORT, API_HOST)

# Watch mode (auto-reload dev)
npm run api:dev

# Documentation interactive
open http://localhost:3000/docs
```

### Endpoints disponibles

**Santé & référentiels**
- `GET /health` — liveness check
- `GET /ready` — readiness check (DB connection)
- `GET /saisons` — saisons disponibles (la plus récente en premier)
- `GET /departements` — référentiel départements (code, nom)
- `GET /ligues` — référentiel ligues (code, nom)

**Clubs** (le `:id_ffhb` accepte l'`id_club` monclub **ou** le code FFHB 7 chiffres — cf. « Deux systèmes d'ID » plus bas)
- `GET /clubs?q=...&departement=...&limit=20&offset=0` — liste paginée (expose `code_ffhb`)
- `GET /clubs/:id_ffhb` — détail club + salle (+ `code_ffhb`)
- `GET /clubs/:id_ffhb/matchs?saison=&include_ententes=&date_from=&date_to=&statut=&min_confidence=&limit=&offset=` — calendrier (cf. détail plus bas)
- `GET /clubs/:id_ffhb/equipes?saison=` — équipes propres du club (pont `ext_structure_id = id_ffhb`)
- `GET /clubs/:id_ffhb/joueurs` — joueurs licenciés du club (préfixe licence = `code_ffhb`) + matchs/buts
- `GET /clubs/:id_ffhb/classements?saison=` — positions de toutes les équipes du club (dernier snapshot)

**Compétitions / poules**
- `GET /competitions?saison=&niveau=&sexe=&q=&limit=&offset=` — liste paginée
- `GET /competitions/:id_ffhb` — détail + phases + poules imbriquées
- `GET /poules/:id_ffhb?saison=` — poule + contexte compétition/phase + classement inline

**Équipes**
- `GET /equipes/:id_ffhb?saison=` — détail (club via pont `ext_structure_id`, + engagements)
- `GET /equipes/:id_ffhb/matchs?saison=&date_from=&date_to=&statut=&limit=&offset=` — matchs (dom + ext)
- `GET /equipes/:id_ffhb/joueurs?saison=` — effectif (joueurs distincts via `match_compositions`)

**Matchs**
- `GET /matchs?poule_id_ffhb=...&date_from=...&date_to=...&statut=...` — liste
- `GET /matchs/:id_ffhb_match` — détail enrichi (compositions + actions + arbitres + fdm_url)

**Classements & stats**
- `GET /classements?poule_id_ffhb=X` — classement poule
- `GET /stats-joueurs?poule_id_ffhb=X&limit=&offset=` — buteurs/stats de la poule (dernier snapshot)

**Joueurs & arbitres**
- `GET /joueurs/:numero_licence` — détail + stats agrégées + historique 10 derniers matchs
- `GET /joueurs/:numero_licence/matchs?limit=&offset=` — historique complet paginé
- `GET /arbitres?q=...&niveau=...&limit=&offset=` — liste (recherche floue)
- `GET /arbitres/:id_ffhb` — détail (+ `nb_matchs`)
- `GET /arbitres/:id_ffhb/matchs?limit=&offset=` — matchs arbitrés

**Salles**
- `GET /salles/:id_ffhb` — détail salle
- `GET /salles/:id_ffhb/matchs?date_from=&date_to=&statut=&limit=&offset=` — matchs accueillis

**Recherche & méta**
- `GET /search?q=...&type=clubs|equipes|joueurs|all` — fuzzy search
- `GET /openapi.json` — spec OpenAPI 3.1
- `GET /docs` — Swagger UI

### Deux systèmes d'ID club (important)

Côté FFHB, deux identifiants distincts coexistent :
- **`id_club` monclub** (ex. `1720`) = `core.clubs.id_ffhb` = `core.equipes.ext_structure_id`. C'est le `:id_ffhb` historique des routes clubs, et la clé de la couche **structure**.
- **Code FFHB 7 chiffres** (ex. `5221105`, préfixe de `email_club`) = `core.clubs.code_ffhb` (colonne générée) = préfixe des `numero_licence` = code sur les FdM. C'est la clé de la couche **licence**.

Les endpoints clubs (`/clubs/:id_ffhb`, `/clubs/:id_ffhb/matchs|equipes|joueurs|classements`) résolvent **l'un ou l'autre**.

#### Détail : GET /clubs/:id_ffhb/matchs

Endpoint le plus complexe : retourne le calendrier d'un club incluant les matchs des équipes liées,
détectées par une **union multi-signal** (cf. spec `docs/superpowers/specs/2026-05-29-club-matchs-precision-design.md`).

**Paramètres query :**
- `saison` : code saison (défaut `2025-2026`)
- `include_ententes` : `true` (défaut) | `false` — inclure les matchs des équipes ententes
- `date_from` / `date_to` : filtre plage dates (ISO 8601)
- `statut` : `joue` | `a_jouer` | `reporte` | `annule` | `forfait`
- `min_confidence` : `haute` | `moyenne` | `basse` — ne garder que les liens de confiance ≥ seuil
- `limit` / `offset` : pagination (max 100)

**Détection des équipes liées (5 signaux, tag `match_method` + `confidence`) :**
| Méthode | Confiance | Règle | Données |
|---|---|---|---|
| `licence` | haute | ≥ 3 licenciés du club (`left(numero_licence,7) = code_ffhb`) ont joué pour l'équipe | FdM (`match_compositions`) |
| `structure` | haute | `equipes.ext_structure_id = club.id_ffhb` (= id_club) — capture les équipes propres + réserves | équipes scrapées (pré-FdM) |
| `nom_exact` | haute | `nom = club.nom` | toujours |
| `nom_reserve` | moyenne | `nom ILIKE club.nom || ' %'` (« X 2 », « X B »…) | toujours |
| `nom_entente` | basse | entente partageant un token distinctif (mot entier, hors STOPWORDS) avec le club | toujours |

La couche `licence` est le seul signal qui capture les **ententes** de façon fiable (un club fournit
plusieurs licenciés à son entente). Elle ne s'active qu'avec des données FdM. La couche `structure`
donne un matching **autoritatif pré-FdM** des équipes propres. Le textuel reste le fallback.

**Champs enrichis sur chaque match :** `club_recevant`, `via_entente`, `via_principal`, `confidence`.

**`meta.equipes_liees`** : liste transparente des équipes liées, avec `is_principal`, `is_entente`,
`match_method` et `confidence`.

### Authentification par clé API (monétisation)

Désactivée par défaut (mode libre). Activée en prod via `API_AUTH_ENABLED=true` dans `.env`.

**Comportement (auth activée) :**
- Public (sans clé) : `/health`, `/ready`, `/openapi.json`, `/docs`, `/admin/*`.
- Tout le reste : header `Authorization: Bearer <token>` (ou `X-API-Key: <token>`) requis. Sinon `401 UNAUTHORIZED`.
- Une clé est refusée si révoquée (`active=false`) ou expirée (`valid_until < now()`).
- Le rate-limit devient **par clé** (`rate_limit_per_min` de la clé) au lieu de par IP.

**Abonnement :** chaque clé porte `valid_until`. Le système de paiement (site externe) avance cette
date d'un mois à chaque règlement. Si l'abonnement lapse, la clé expire d'elle-même.

**Gestion des clés — CLI** (sur le serveur) :
```bash
npm run apikey -- create --label=client@example.com --months=1   # token affiché UNE FOIS
npm run apikey -- list
npm run apikey -- renew  --prefix=ffhb_xxxxxxxx --months=1        # à chaque paiement
npm run apikey -- revoke --prefix=ffhb_xxxxxxxx
```

**Gestion des clés — endpoints admin** (pour le site, garde `X-Admin-Secret: $ADMIN_SECRET`) :
```bash
# Créer une clé (à l'abonnement) — retourne le token UNE FOIS
curl -X POST https://api.ton-domaine.fr/admin/api-keys \
  -H "X-Admin-Secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"label":"client@example.com","months":1}'
# Renouveler (à chaque paiement) / Révoquer (résiliation)
curl -X POST .../admin/api-keys/ffhb_xxxxxxxx/renew  -H "X-Admin-Secret: $ADMIN_SECRET" -d '{"months":1}'
curl -X POST .../admin/api-keys/ffhb_xxxxxxxx/revoke -H "X-Admin-Secret: $ADMIN_SECRET"
```
Sans `ADMIN_SECRET` configuré, `/admin/*` renvoie `503`. Le token n'est **jamais** restitué après
création (seul son hash sha256 est stocké).

**Intégration site de paiement (Stripe → endpoints admin) :** voir
[`docs/billing-integration.md`](billing-integration.md) (flux abonnement/renouvellement/résiliation,
exemples de webhooks, règles de sécurité).

### Rate-limit

Par défaut 60 req/min **par IP** (`API_RATE_LIMIT_PER_MIN`). Si l'auth est activée, les requêtes
authentifiées sont limitées **par clé** (`rate_limit_per_min` de la clé, défaut `API_KEY_DEFAULT_RATE_LIMIT_PER_MIN`). Headers retournés :
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- 429 + `Retry-After` si dépassé

### Format réponse

Succès liste : `{ data: [...], meta: { total, limit, offset } }`
Succès détail : `{ data: {...} }`
Erreur : `{ error: { code, message } }`
