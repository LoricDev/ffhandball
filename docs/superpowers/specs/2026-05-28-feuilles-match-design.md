---
name: Feuilles de match (FdM) — PDF parsing
description: Design de la 9ème feature — téléchargement et parsing des feuilles de match officielles FFHandball pour alimenter joueurs, compositions, stats par match et déroulé chronologique
type: spec
date: 2026-05-28
---

# Feuilles de match (FdM)

## Contexte

Les 8 features publiques du pipeline sont livrées. Les données joueurs publiques (`core.stats_joueurs`) sont limitées : stats agrégées par compétition (national + régional séniors) sans n° licence, sans détail par match, sans déroulé.

**Découverte décisive** : les feuilles de match (FdM) officielles FFHandball sont accessibles publiquement en PDF, indexées par `fdmCode` (champ déjà capturé dans `raw.matchs.payload`).

**URL pattern** : `https://media-ffhb-fdm.ffhandball.fr/fdm/{c1}/{c2}/{c3}/{c4}/{fdmCode}.pdf` où `c1..c4` sont les 4 premières lettres du code. Exemple : `VAGPOQJ` → `/fdm/V/A/G/P/VAGPOQJ.pdf`.

**Validation** : PDF v1.4, 2 pages, ~300 KB en moyenne, **texte extractible** (testé avec `pdf-parse` v2). Contenu : composition complète avec n° licence, stats par joueur (buts, 7m, tirs, arrêts, sanctions), déroulé chronologique action par action.

Référence pipeline globale : `docs/superpowers/specs/2026-05-18-ffhandball-data-pipeline-design.md`.

## Objectifs

- **Télécharger les FdM PDF** pour chaque match présent dans `raw.matchs` avec `fdmCode` non vide
- **Parser** la composition (page 1) et le déroulé (page 2) via `pdf-parse` v2 (Node-pur)
- **Peupler `core.joueurs`** avec numero_licence FFHB officiel (la table reste vide jusqu'à présent)
- **Enrichir `core.match_compositions`** avec stats par joueur par match (buts, 7m, tirs, arrêts, sanctions)
- **Créer `core.match_actions`** (nouvelle) pour stocker le déroulé chronologique action par action
- **Étendre `core.match_officiels`** pour les rôles non-arbitre (secrétaire, tuteur, etc.)
- **Idempotence** : un re-parse de la même FdM ne crée pas de doublons (PK composites + UNIQUE)
- **Scope total** : toutes les compétitions ayant un `fdmCode` (national + régional + départemental — pas de filtrage)

## Non-objectifs

- Pas de stockage des PDFs bruts sur disque (`raw.feuilles_match.payload` contient le texte extrait structuré, pas le binaire)
- Pas de date de naissance / sexe / nationalité — non exposés dans la FdM (les colonnes existantes en `core.joueurs` restent NULL)
- Pas de résolution `club_rattachement_id` joueur (5 premiers chiffres du n° licence = code club mais corrélation potentiellement imparfaite — feature future)
- Pas de gestion OCR (les FdMs sont text-based, pas scannées — vérifié)
- Pas de stats inférées du déroulé (ex: "minutes jouées par joueur") — peut être calculé côté API si besoin

## Architecture

```
raw.matchs.payload.fdm_code (existant, ~50-200k entrées selon scope)
        │
        ▼ Pour chaque fdm_code unique :
        │
fetch https://media-ffhb-fdm.ffhandball.fr/fdm/{c1}/{c2}/{c3}/{c4}/{fdmCode}.pdf
        │ (rate-limited ≥2s, UA identifiable, nocturne pour full run)
        ▼
parseFdmPdf(pdfBuffer, sourceUrl, fdmCode) :
  - Page 1 : header (code, compétition, score) + officiels (table+arbitres) + 2 compositions équipes (avec licences + stats par joueur)
  - Page 2 : déroulé chronologique (période, temps, score, action, joueur)
  - Retour : { metadata, officiels, compositions: [recevant, visiteur], actions }
        │
        ▼
raw.feuilles_match (natural_key = fdmCode, payload JSONB structuré)
        │
        ▼
feuilles-match.etl → cascade vers core :
  1. core.joueurs (UPSERT par numero_licence)
  2. core.match_officiels (UPSERT — rôles étendus)
  3. core.match_compositions (UPSERT par (match_id, joueur_id))
  4. core.match_actions (UPSERT par (match_id, periode, temps_seconds, ordre))
```

**Nouvelle commande CLI** : `npm run scrape -- --entity=feuilles-match --saison=<S> [--limit=N]`  
**Nouvelle ETL** : `npm run etl -- --entity=feuilles-match --saison=<S>` (cascade transactionnelle par FdM)

**Ordre ETL global final** : `... → matchs → arbitres → match_officiels → classements → stats-joueurs → feuilles-match`

## Composants

### Nouveaux fichiers

- `src/lib/pdf-parser.ts` — wrapper autour de `pdf-parse` v2 (1 fonction réutilisable)
- `src/scrapers/ffhandball/fdm-pdf.parser.ts` — parser FdM (texte extrait → structure typée)
- `src/schemas/feuille-match.schema.ts` — schéma Zod du payload `raw.feuilles_match`
- `src/etl/feuilles-match.etl.ts` — pipeline cascade `raw.feuilles_match → core.{joueurs, match_compositions, match_actions, match_officiels}`
- `db/migrations/0015_feuilles_match_extensions.sql` — extensions schéma core
- `tests/fixtures/fdm-VAGPOQJ.pdf` (FdM réelle, 2 pages, 326 KB)
- `tests/fixtures/fdm-VAGPOQJ-expected.json` (résultat attendu du parser pour TDD)
- `tests/schemas/feuille-match.schema.test.ts`
- `tests/scrapers/fdm-pdf.parser.test.ts`
- `tests/etl/feuilles-match.etl.test.ts`
- `tests/integration/feuilles-match-end-to-end.test.ts`

### Fichiers modifiés

- `src/cli/scrape.ts` — handler `scrapeFeuillesMatch` + dispatch
- `src/cli/etl.ts` — accepter `--entity=feuilles-match`
- `package.json` — dépendance `pdf-parse` v2 (déjà testée localement)
- `docs/runbook.md` — section "Scraper les feuilles de match (FdM)"

## Source de données — structure FdM

### Page 1 — Composition + score

Exemple FdM `VAGPOQJ` (Honneur Masculin Moselle, ETAIN vs SARRALBE) :

```
Organisateur LIGUE GRAND EST DE HANDBALL (5600000) Code Renc VAGPOQJ
Compétition 56-03 CHAMPIONNAT HONNEUR MASCULIN HONNEUR MASCULIN
56-HONNEUR MASC POULE 3 Groupe M56000202G
ETAIN RAYON ARTISTIQUE SPORTIF STAINOIS / SARRALBE 23 37
DATE: samedi 25/04/2026 20:30 Journée / Date
J18 du 28/03/26 au 29/03/26 SALLE: 5655 - OMNISPORT DE LA GALAVAUDE
1 RUE DUCOLONEL DRIAND 55100 VERDUN

Chronométreur LODOVICI enzo 5655011101546   Juge Arbitre 1 ATAMNA emma 5654005201585
Secrétaire    LODOVICI adrien 5655011101545  Juge Arbitre 2 ATAMNA mourad 5654005101584
Responsable de Salle ROBIN gauthier 5655011101541
Officiel Resp A BAUDSON william 5655011101256 ...

Club Recevant ETAIN RAYON ARTISTIQUE SPORTIF STAINOIS (5655011)
Capt N° NOM prénom (Nom d'usage) Licence Type Lic Buts 7m Tirs Arrets Av. 2' Dis
    25 BAUDSON valentin           5655011101039   A    3       8
    51 BOUTROU nicolas             5655011100522   A    1
    99 BURTEAUX cyril               5655011101544   A    1       2
    57 GRAMACCIONI matys           5655011101498   A    7      10
     4 HACQUIN david                5655011101461   A    1       1   1
  X 95 MACEL dylan                  5655011101499   A    1       1   2   ← X = gardien
    17 MANGEOL regis                5655011101061   A    3       6
    ...

Club Visiteur SARRALBE (5657027)
Capt N° NOM prénom (Nom d'usage) Licence Type Lic Buts 7m Tirs Arrets Av. 2' Dis
    82 AKCIL mehmet                 5657027100847   A    3   3   3
    31 BEAUVOIS logan               5657027101251   B    6       7
  X  8 BLATNIK noah                 5657027101035   A    6       8
    ...
    23 GROSSE thomas                5657027100959   A    3   3       X   1   ← X dans Av. = avertissement
     3 NEMSGUERS michel             5657027100705   A    2   2       X   2

DETAIL SCORE
              Période 1   Fin Tps Reglem.   Prolongation 1   Prolongation 2   Tirs au Buts
              REC  VIS    REC  VIS          REC  VIS         REC  VIS         REC  VIS
              10   17     23   37
Statut Match : JOUE
```

### Page 2 — Déroulé chronologique

```
Déroulé du Match
PERIODE 1                                PERIODE 2
Temps   Score    Action                  Temps   Score    Action
02:41   00 - 00  Arrêt JR N°95 MACEL dylan        30:40   10 - 18  But JV N°18 MOFTAR yanisse
03:00   01 - 00  But JR N°22 SUSSENAIRE romain    31:04   11 - 18  But JR N°22 SUSSENAIRE romain
03:14   02 - 00  But JR N°57 GRAMACCIONI matys    31:21   11 - 19  But JV N°31 BEAUVOIS logan
03:45   02 - 01  But JV N°18 MOFTAR yanisse       31:48   11 - 19  Tir JR N°14 RICHARD noe
...
21:53   08 - 11  Avertissement OV KOZLICIC alen   ← OV = Officiel Visiteur
21:53   08 - 11  2MN JV N°82 AKCIL mehmet
22:00   08 - 12  But JV N°23 GROSSE thomas
...
52:26   18 - 30  Protocole Commotion JR N°25 BAUDSON valentin
```

**Codes acteurs** :
- `JR` = Joueur Recevant
- `JV` = Joueur Visiteur
- `OR` / `OV` = Officiel Recevant / Visiteur

**Types d'action observés** :
- `But` — score change
- `Tir` — pas de but (raté ou arrêté)
- `Arrêt` — gardien
- `Avertissement` — carton jaune
- `2MN` — exclusion 2 minutes
- `Disqualification` (rare)
- `Temps Mort d'Equipe {Recevant|Visiteur}`
- `Protocole Commotion`

## Schéma Zod payload `raw.feuilles_match`

```ts
// src/schemas/feuille-match.schema.ts
import { z } from "zod";

const intOrNull = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  },
  z.number().int().nullable(),
);

export const rawJoueurInFdmSchema = z.object({
  numero_licence: z.string().regex(/^\d{10,13}$/),  // 13 chiffres typiquement
  nom: z.string().min(1),
  prenom: z.string().min(1),
  type_licence: z.string().length(1),                // A, B, C...
  numero_maillot: intOrNull,
  capitaine: z.boolean(),
  gardien: z.boolean(),
  buts: intOrNull,
  sept_metres_reussis: intOrNull,                    // "n / m" format peut être présent
  sept_metres_tentes: intOrNull,
  tirs: intOrNull,
  arrets: intOrNull,
  avertissement: z.boolean(),                        // X = présent
  exclusions_2min: intOrNull,                        // nombre (1, 2, 3) ou null
  disqualifie: z.boolean(),
});

export const rawOfficielInFdmSchema = z.object({
  role: z.string(),                                  // chronometreur, secretaire, juge_arbitre_1, juge_arbitre_2, responsable_salle, officiel_resp_a, officiel_b, ...
  cote: z.enum(["recevant", "visiteur", "neutre"]),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  numero_licence: z.string().regex(/^\d{10,13}$/).optional(),
});

export const rawActionInFdmSchema = z.object({
  ordre: z.number().int().nonnegative(),             // ordre chronologique global (recalculé au parse)
  periode: z.number().int().min(1).max(4),           // 1, 2, prolongations, tirs au but
  temps_seconds: z.number().int().nonnegative(),     // mm:ss → secondes
  score_recevant: z.number().int().nonnegative(),
  score_visiteur: z.number().int().nonnegative(),
  type_action: z.enum([
    "but", "tir", "arret", "avertissement",
    "exclusion_2min", "disqualification",
    "temps_mort_recevant", "temps_mort_visiteur",
    "protocole_commotion", "autre",
  ]),
  cote: z.enum(["recevant", "visiteur"]).optional(), // pour but/tir/arret/sanction
  numero_maillot: z.number().int().nullable().optional(),
  numero_licence: z.string().optional(),             // résolu via composition (par numero_maillot + cote)
  acteur_role: z.enum(["joueur", "officiel"]).optional(), // pour distinguer OR/OV vs JR/JV
  description_brute: z.string(),                     // ligne brute pour debug
});

export const rawFeuilleMatchPayloadSchema = z.object({
  fdm_code: z.string().min(1),                       // natural key
  organisateur: z.string().optional(),
  organisateur_code: z.string().optional(),
  competition_libelle: z.string().optional(),
  groupe: z.string().optional(),
  poule_libelle: z.string().optional(),

  equipe_recevant_libelle: z.string(),
  equipe_visiteur_libelle: z.string(),
  equipe_recevant_code: z.string().optional(),       // code club (5655011)
  equipe_visiteur_code: z.string().optional(),

  date_heure_str: z.string(),                        // "samedi 25/04/2026 20:30" brut
  journee_libelle: z.string().optional(),
  salle_libelle: z.string().optional(),
  salle_adresse: z.string().optional(),

  score_recevant: intOrNull,
  score_visiteur: intOrNull,
  score_mi_temps_recevant: intOrNull,
  score_mi_temps_visiteur: intOrNull,
  statut_match: z.string().optional(),               // "JOUE", "REPORTE", "FORFAIT", etc.

  officiels: z.array(rawOfficielInFdmSchema),
  composition_recevant: z.array(rawJoueurInFdmSchema),
  composition_visiteur: z.array(rawJoueurInFdmSchema),
  actions: z.array(rawActionInFdmSchema),

  source_url: z.string().url(),
  pdf_size_bytes: z.number().int().positive().optional(),
});
export type RawFeuilleMatchPayload = z.infer<typeof rawFeuilleMatchPayloadSchema>;
```

**natural_key** : `fdm_code` (ex `"VAGPOQJ"`).

## Migration `0015_feuilles_match_extensions.sql`

```sql
-- 1. Étendre core.match_compositions : stats fines par joueur par match
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS type_licence TEXT;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS tirs_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS arrets_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS sept_metres_tentes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS sept_metres_reussis INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS avertissement BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS disqualifie BOOLEAN NOT NULL DEFAULT false;

-- carton_jaune existant ≡ avertissement (on garde les 2 pour rétrocompat, alimentés tous les deux)
-- exclusion_2min_count existant ≡ count des 2MN observés (déjà nb entier)
-- but_count existant ≡ buts marqués (déjà OK)

-- 2. Étendre core.match_officiels : nouveaux rôles
ALTER TABLE core.match_officiels DROP CONSTRAINT IF EXISTS match_officiels_role_check;
ALTER TABLE core.match_officiels ADD CONSTRAINT match_officiels_role_check
  CHECK (role IN (
    'arbitre_1', 'arbitre_2',
    'delegue', 'observateur',
    'chrono', 'chronometreur', 'secretaire',
    'tuteur_table', 'juge_delegue',
    'responsable_salle', 'speaker',
    'officiel_resp_a', 'officiel_b', 'officiel_c', 'officiel_d',
    'kine', 'medecin',
    'accompagnateur'
  ));

-- 3. Créer core.match_actions (déroulé chronologique)
CREATE TABLE IF NOT EXISTS core.match_actions (
  id              bigserial PRIMARY KEY,
  match_id        bigint NOT NULL REFERENCES core.matchs(id) ON DELETE CASCADE,
  ordre           integer NOT NULL,                 -- ordre chronologique 1..N
  periode         integer NOT NULL CHECK (periode BETWEEN 1 AND 4),
  temps_seconds   integer NOT NULL CHECK (temps_seconds >= 0),
  score_recevant  integer NOT NULL CHECK (score_recevant >= 0),
  score_visiteur  integer NOT NULL CHECK (score_visiteur >= 0),
  type_action     text NOT NULL CHECK (type_action IN (
    'but', 'tir', 'arret', 'avertissement',
    'exclusion_2min', 'disqualification',
    'temps_mort_recevant', 'temps_mort_visiteur',
    'protocole_commotion', 'autre'
  )),
  cote            text CHECK (cote IN ('recevant', 'visiteur')),
  joueur_id       bigint REFERENCES core.joueurs(id),    -- résolu via composition
  numero_maillot  integer,                              -- backup brut
  acteur_role     text CHECK (acteur_role IN ('joueur', 'officiel')),
  description_brute text,
  CONSTRAINT uq_match_actions UNIQUE (match_id, ordre)
);
CREATE INDEX IF NOT EXISTS idx_match_actions_match  ON core.match_actions (match_id);
CREATE INDEX IF NOT EXISTS idx_match_actions_joueur ON core.match_actions (joueur_id);
CREATE INDEX IF NOT EXISTS idx_match_actions_type   ON core.match_actions (type_action);

-- 4. Étendre core.matchs : fdm_code + fdm_url
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_code TEXT;
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_url TEXT;
CREATE INDEX IF NOT EXISTS idx_matchs_fdm_code ON core.matchs (fdm_code);

-- 5. core.joueurs : aucune modification (schéma existant convient)
--    numero_licence NOT NULL UNIQUE, nom NOT NULL, prenom NOT NULL — tout est fourni par la FdM
--    date_naissance, sexe, nationalite : restent NULL (non exposés par la FdM)
```

## Logique parsing PDF

### `parseFdmPdf(buffer: Buffer, sourceUrl: string, fdmCode: string): RawFeuilleMatchPayload | null`

**Pipeline en 4 étapes** :

1. **Extraction texte** via `pdf-parse` v2 (`new PDFParse({ data: buf }).getText()`)
   - Retourne `{ pages: [{ text, num }] }`
   - Pas de retry — si parse fail, retourne null

2. **Parse page 1 (composition)** :
   - Header : regex pour extraire `Code Renc`, `Compétition`, `Groupe`, `Poule`, équipes (split sur `/`), date, salle
   - Score final : ligne unique format `XX YY` (recevant visiteur)
   - Score mi-temps : `Période 1 \n REC VIS \n NN MM`
   - Officiels de table : sections labellisées (Chronométreur, Secrétaire, etc.) avec format `LABEL nom prenom licence`
   - Compositions équipes : 2 blocs `Club {Recevant|Visiteur} {libellé} ({code}) ... Capt N° ... \n {lignes joueurs}`
     - Chaque ligne joueur : regex `(X?) (\d+) ([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ ]+) (\w+(?:[ -]\w+)*) (\d{10,13}) ([A-Z]) (\d*) (\d*) (\d*) (\d*) (X?) (\d*) (X?)`
       - capt (X ou vide), n°, NOM (majuscules), prenom (parfois composé), licence, type, buts, 7m, tirs, arrêts, Av. (X ou vide), 2', Dis (X ou vide)
     - **Note** : le parsing est tabulaire. Les colonnes vides apparaissent comme espaces multiples ou absences. Implémenter via découpage sur regex line-by-line + validation Zod par ligne.

3. **Parse page 2 (déroulé)** :
   - Détecter sections `PERIODE 1` et `PERIODE 2`
   - Pour chaque ligne d'action : regex `(\d+:\d+)\s+(\d+)\s*-\s*(\d+)\s+(.+)`
     - Temps `mm:ss`, score `NN - MM`, description action
   - Parser la description :
     - `But J{R|V} N°NN NOM prenom` → type=but, cote=R/V, numero_maillot=NN, acteur=joueur
     - `Tir J{R|V} N°NN NOM prenom` → type=tir
     - `Arrêt J{R|V} N°NN NOM prenom` → type=arret
     - `Avertissement {J{R|V} N°NN|O{R|V}} NOM prenom` → type=avertissement
     - `2MN J{R|V} N°NN ...` → type=exclusion_2min
     - `Disqualification ...` → type=disqualification
     - `Temps Mort d'Equipe {Recevant|Visiteur}` → type=temps_mort_{...}, cote=...
     - `Protocole Commotion J{R|V} N°NN ...` → type=protocole_commotion
     - Autre → type=autre, description_brute conservée
   - `ordre` calculé en parcours linéaire (P1 puis P2)
   - `temps_seconds` = minutes*60 + secondes

4. **Validation Zod globale** via `rawFeuilleMatchPayloadSchema.safeParse(...)`. Si fail → return null + log warn.

**Robustesse** : le parser doit gérer :
- Joueurs sans certaines stats (colonnes vides → 0)
- Noms composés avec espaces ou tirets (ex `tom - MEYER-MATTA`, `BAUDSON William` en officiel)
- Noms à particule (ex `DE LA TORRE`) — premier mot considéré comme NOM
- Lignes manquantes ou réordonnées (regex tolérantes)
- 7m affichés en format `n` (réussis), `n / m` (réussis / tentés), ou vide

## Logique CLI scrape

```ts
async function scrapeFeuillesMatch(saison: string, opts: { limit? }) {
  const run = await startScrapeRun({ ..., scraper_name: "feuilles-match", saison });

  try {
    // 1. Récupérer les fdmCodes uniques depuis raw.matchs (filtrer ceux déjà en raw.feuilles_match pour éviter le re-download)
    const codes = await query<{ fdm_code: string }>(`
      SELECT DISTINCT m.payload->>'fdm_code' AS fdm_code
        FROM raw.matchs m
        WHERE m.saison = $1
          AND m.payload->>'fdm_code' IS NOT NULL
          AND m.payload->>'fdm_code' != ''
          AND NOT EXISTS (
            SELECT 1 FROM raw.feuilles_match fm
            WHERE fm.natural_key = m.payload->>'fdm_code' AND fm.saison = $1
          )
        ORDER BY fdm_code
    `, [saison]);

    let toProcess = codes.rows;
    if (opts.limit !== undefined) toProcess = toProcess.slice(0, opts.limit);

    let totalSuccess = 0, total404 = 0, parseFail = 0;
    for (const { fdm_code } of toProcess) {
      const url = `https://media-ffhb-fdm.ffhandball.fr/fdm/${fdm_code[0]}/${fdm_code[1]}/${fdm_code[2]}/${fdm_code[3]}/${fdm_code}.pdf`;
      const res = await fetchBinary(url);  // helper similar à fetchHtml mais retourne buffer
      await run.incrementPages(1);
      if (res.status === 404) { total404++; continue; }
      if (res.status >= 400) { logger.warn(...); continue; }

      const parsed = parseFdmPdf(res.body, url, fdm_code);
      if (!parsed) { parseFail++; continue; }

      await insertRaw("feuilles_match", {
        scrape_run_id: run.id,
        source_url: url,
        source_site: "media-ffhb-fdm.ffhandball.fr",
        natural_key: fdm_code,
        payload: parsed,
        saison,
        http_status: res.status,
      });
      totalSuccess++;
    }
    logger.info({ totalSuccess, total404, parseFail }, "feuilles-match scrape done");
    await run.finishSuccess();
  } catch (err) {
    await run.finishFailure(err); throw err;
  }
}
```

**`fetchBinary`** : nouveau helper léger (ou extension de `fetchHtml` qui prend un flag). Retourne `{ status, body: Buffer, contentType }`.

## Logique ETL — `runFeuillesMatchEtl(saison)`

Cascade idempotente par FdM, transactionnelle (BEGIN/COMMIT par row pour éviter qu'un échec partiel laisse de la corruption) :

```ts
for (const fm of raw.feuilles_match rows) {
  await query("BEGIN");
  try {
    // 0. UPDATE core.matchs SET fdm_url = $source_url WHERE fdm_code = $fdm_code
    //    (lien PDF servi par l'API future, peuplé après téléchargement réussi)
    // 1. Résoudre match_id via core.matchs.id_ffhb_match — match.id_ffhb_match peut être l'ext_rencontre_id du payload raw.matchs.
    //    Le fdm_code seul n'est pas dans core.matchs ; il faut le lookup via raw.matchs payload.
    //    Approche : trouver le match via fdm_code en parcourant raw.matchs payload
    const matchRes = await query(`
      SELECT m.id FROM core.matchs m
      WHERE m.id_ffhb_match = (
        SELECT DISTINCT rm.payload->>'ext_rencontre_id' FROM raw.matchs rm
        WHERE rm.payload->>'fdm_code' = $1 AND rm.saison = $2
        LIMIT 1
      )
    `, [fm.fdm_code, saison]);
    const match_id = matchRes.rows[0]?.id;
    if (!match_id) { /* warning + skip */ ROLLBACK; continue; }

    // 2. Pour chaque joueur des 2 compositions :
    //    UPSERT core.joueurs par numero_licence (UNIQUE existant)
    //    On obtient joueur_id
    // 3. UPSERT core.match_compositions par (match_id, joueur_id) avec stats
    // 4. UPSERT core.match_officiels (officiels de table) avec rôles étendus.
    //    Pour les arbitres : on doit créer un core.arbitres si n'existe pas (via numero_licence)
    //    Note : core.arbitres et core.joueurs sont 2 tables séparées avec leurs propres UNIQUE.
    //    Décision : un officiel = arbitre OU joueur ? Les officiels de table FdM sont souvent des licenciés du club.
    //    Approche pragmatique : si rôle ∈ ('juge_arbitre_1','juge_arbitre_2','juge_delegue','observateur') → core.arbitres
    //    Sinon → on ne stocke pas dans match_officiels (les officiels club non-arbitres ne sont pas dans ce schéma)
    //    OU on étend match_officiels avec une FK joueur_id en + de arbitre_id... feature future.
    //    Décision finale : on stocke uniquement arbitres dans match_officiels (juges-arbitres et déléqués officiels).
    //    Les officiels de table (chrono, secrétaire, etc.) sont conservés dans raw.feuilles_match.payload pour l'instant.
    // 5. core.match_actions : INSERT par (match_id, ordre) UNIQUE. ON CONFLICT DO UPDATE (rejouable).
    //    joueur_id résolu via composition existante (lookup numero_maillot + cote → joueur_id)

    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK");
    // log warning, continue
  }
}
```

**Note importante** : `core.matchs.id_ffhb_match` doit avoir une correspondance avec `fdm_code`. **Mais ce n'est pas le cas** — `id_ffhb_match = ext_rencontre_id` (ex "2388869") ≠ `fdm_code` (ex "VAGPOQJ"). Le lien se fait via `raw.matchs.payload->>'fdm_code'`. **Solution** : ajouter deux colonnes à `core.matchs` lors de la migration 0015 :

```sql
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_code TEXT;
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_url TEXT;
CREATE INDEX IF NOT EXISTS idx_matchs_fdm_code ON core.matchs (fdm_code);
```

- `fdm_code` : code court FFHB (ex `"VAGPOQJ"`), peuplé par l'ETL `matchs` étendu depuis `raw.matchs.payload.fdm_code`. Sert de natural key pour résoudre `match_id ↔ FdM` côté ETL `feuilles-match`.
- `fdm_url` : URL complète du PDF FdM (ex `"https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/VAGPOQJ.pdf"`), peuplée par l'ETL `feuilles-match` après téléchargement réussi (HTTP 200). Permet à l'API future de servir directement le lien sans recalcul du pattern. NULL tant que le PDF n'a pas été téléchargé/parsé (FdM pas encore publiée pour les matchs futurs, ou pas encore scrapé).

Cette modification est mineure (pas de breakage). L'ETL `matchs` existant est étendu de quelques lignes pour propager `fdm_code` (déjà dans le payload Zod-validé).

## CLI

```bash
# Dev — 5 FdMs (test)
npm run scrape -- --entity=feuilles-match --saison=2025-2026 --limit=5

# Run complet (~50-200k FdMs, ~30-100h selon scope matchs, à étaler sur plusieurs nuits)
npm run scrape -- --entity=feuilles-match --saison=2025-2026

# ETL (cascade joueurs + compositions + match_actions + match_officiels arbitres)
npm run etl -- --entity=feuilles-match --saison=2025-2026
```

## Tests

### Fixtures à capturer (T1)

- `tests/fixtures/fdm-VAGPOQJ.pdf` (FdM réelle de l'exemple user, 2 pages, ETAIN/SARRALBE) — committée binaire dans le repo (~326 KB, acceptable)
- `tests/fixtures/fdm-VAGPOQJ-expected.json` (résultat attendu du parser, sérialisé pour TDD)

### Tests parser PDF (8 tests)

- Extract metadata (code, compétition, équipes, score final, date)
- Extract score mi-temps depuis bloc DETAIL SCORE
- Extract composition recevant (11 joueurs + officiels)
- Extract composition visiteur (10 joueurs + officiels)
- Détecte capitaine (X colonne 1)
- Détecte gardien (par convention : numero_maillot souvent 1 ou 12 — heuristique faible) OU via présence d'arrêts > 0
- Parse 7m format "n" et "n/m"
- Parse actions page 2 : but, tir, arrêt, avertissement, 2MN, temps mort, protocole commotion
- Convertit temps "mm:ss" en secondes
- Gère noms composés ("tom - MEYER-MATTA")
- Returns null on malformed PDF buffer

### Tests schéma Zod (5 tests)

- Accepts complete payload
- Rejects empty fdm_code
- Rejects malformed numero_licence (regex 10-13 digits)
- intOrNull preprocess gère ""/null/string/number
- Sous-schémas (joueur, officiel, action) validés indépendamment

### Tests ETL (8 tests)

- Insert FdM nominal : match résolu via fdm_code, joueurs UPSERT, compositions UPSERT, actions INSERT
- Idempotence : 2 runs ETL → mêmes counts
- match.fdm_code non résolu → warning + skip
- Joueur licence existante (autre match) → 0 insert dans joueurs, mais composition créée
- core.joueurs : COALESCE preserves DDN/sexe (qui restent NULL)
- Action sans joueur résolvable (numéro maillot orphelin) → joueur_id=NULL, description_brute conservée
- Re-run modifié (FdM updated) → update stats
- Transaction rollback si l'une des étapes fail (test avec FK invalide)
- `afterAll(closePool)`

### Tests intégration (2 tests)

- Setup : seed full hierarchy (compétition + phase + poule + équipes + match avec fdm_code='VAGPOQJ')
- Parse fixture PDF → insertRaw → run ETL → assert counts (joueurs créés, compositions, actions)
- Idempotence

## Cas dégradés

| Cas | Comportement |
|---|---|
| PDF 404 | Skip silencieux + log info (FdM pas encore publiée pour matchs à venir) |
| PDF corrompu (parsing fail) | log warn + `core.etl_rejets` |
| Match sans fdm_code en raw.matchs | Pas scrapé (filtré côté SELECT) |
| Joueur composition sans n° licence (rare, mais théorique) | Skip cette ligne, log warn (FK NOT NULL bloque sinon) |
| Action avec numéro maillot orphelin (joueur retiré in extremis) | Action insérée avec joueur_id=NULL |
| Action de type non reconnu | type_action='autre' + description_brute conservée |
| FdM contient des chars non-ASCII (accents) | UTF-8 natif, gestion native pdf-parse OK |
| Re-scrape modifié (correction FdM par FFH après publication) | Append-only raw, DISTINCT ON garde la plus récente, ETL met à jour |
| Score change entre versions FdM | UPSERT met à jour ; les anciennes raw sont conservées |
| Officiels de table non-arbitres (chrono, secrétaire) | Stockés en raw.feuilles_match.payload mais pas propagés vers core.match_officiels (réservé arbitres). Feature future : table dédiée `core.officiels_table` ou extension du schéma |
| Volumétrie démentielle (10M+ lignes match_actions sur full run) | Indexes prévus (match_id, joueur_id, type) ; partitionnement par saison si besoin futur |

## Volumétrie attendue

| Métrique | Smoke test (5 FdMs) | Run national (~10k matchs) | Full 3 niveaux + journées (~150k matchs) |
|---|---|---|---|
| FdMs téléchargées | 5 | ~10k | ~150k |
| Données téléchargées | 1.5 MB | ~3 GB | ~45 GB |
| Durée @ 2s/req | 10s | ~6h | **~80h** (multi-nuits, étalable) |
| `core.joueurs` lignes | ~150 | ~50k-100k | **~200k-500k** |
| `core.match_compositions` | ~150 | ~250k | **~3M** |
| `core.match_actions` | ~500 | ~1M | **~10M-15M** |

## Pipeline state après cette feature

```
✅ clubs + salles
✅ competitions + phases + poules
✅ equipes + engagements
✅ matchs
✅ arbitres + match_officiels
✅ classements
✅ stats_joueurs (national + régional séniors)
✅ feuilles-match : joueurs + compositions + match_actions  ← cette feature
```

**Couverture finale du pipeline** : 100% des données publiques accessibles sur ffhandball.fr exploitées, y compris les FdMs PDFs jamais scrapées auparavant.

## Future features liées

- **Officiels de table dédiés** : nouvelle table `core.officiels_table` pour chrono, secrétaire, juge tuteur, etc. (rôles club non-arbitres)
- **Résolution `club_rattachement_id` joueurs** : les 5 premiers chiffres du `numero_licence` = code club FFHB. Match avec `core.clubs.id_ffhb` permet de remplir `core.joueurs` un champ `club_principal_id` ou utiliser pour FK `licences`
- **Table `core.licences`** : actuellement vide ; peut être peuplée depuis l'observation joueur ↔ équipe ↔ saison
- **Statistiques avancées** : déduire minutes jouées par joueur depuis le déroulé (entrée/sortie), efficacité tirs (buts/tirs), etc. — vues SQL côté API
- **Match expectancy / Elo joueurs** : à partir des stats individuelles cumulées sur plusieurs saisons
