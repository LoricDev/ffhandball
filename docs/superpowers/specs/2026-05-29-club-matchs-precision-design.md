# Précision renforcée du matching club↔équipes — Design

**Date :** 2026-05-29
**Statut :** Validé (approche hybride multi-signal)
**Périmètre :** `GET /clubs/:id_ffhb/matchs` — étape de résolution des équipes liées à un club.

## Problème

L'endpoint `/clubs/:id_ffhb/matchs` relie un club à ses équipes (principale, réserves, ententes)
via un **matching purement textuel** (`src/api/lib/repositories/club-matchs.repo.ts`). La couche
entente fait un `EXISTS` sur des mots-clés ≥ 4 caractères extraits du nom du club. Ces mots-clés
incluent des termes **génériques** (`HANDBALL`, `CLUB`, `BRETAGNE`, `SPORTING`…), ce qui provoque
des **faux positifs massifs** : n'importe quelle entente contenant « HANDBALL » matche n'importe
quel club. Les couches exact (`e.nom = club.nom`) et réserve (`e.nom ILIKE club.nom || ' %'`) sont
fiables ; le trou de précision est la détection des ententes et, plus généralement, l'absence de
signal structurel autoritatif.

## Faits vérifiés sur le modèle de données

| Fait | Preuve |
|---|---|
| `core.clubs.id_ffhb` = code structure FFHB à 7 chiffres | fixture `6275001`, `6275002` ; schéma `z.string().regex(/^\d+$/)` |
| Préfixe (7 chiffres) du `numero_licence` joueur = code du club | `5655011`100522 → club `5655011` ; la FdM affiche `…(5655011)` |
| `core.match_compositions.equipe_id` = équipe pour laquelle le joueur a joué ce match | schéma confirmé (FK `core.equipes`) |
| `core.equipes.club_id` est **NULL** | l'ETL equipes le laisse non résolu (warning « club_id non résolu ») |
| `core.equipes.ext_structure_id` = code structure de l'équipe | optionnel, peuplé sur scrapes réels (calendar-button) |

**Conséquence clé :** le préfixe de licence est le **seul signal qui identifie les ententes de
façon fiable** — un club fournit plusieurs licenciés à son entente, donc un seuil de N licenciés
distincts filtre les joueurs « invités » ponctuels (mutations).

## Approche : union multi-signal avec tag `match_method` + `confidence`

La résolution des équipes liées devient une **union de 5 signaux**, chacun produisant un ensemble
d'`equipe_id` avec une méthode et un niveau de confiance. On déduplique par `equipe.id` en gardant
la **confiance maximale** (et la méthode correspondante).

| Méthode | Confiance | Règle | Ententes ? | Données requises |
|---|---|---|---|---|
| `licence` | `haute` | ≥ `LICENCE_MATCH_MIN_PLAYERS` (=3) licenciés distincts préfixés `club.id_ffhb` ont joué pour l'équipe | ✅ **oui, précisément** | FdM (`match_compositions`) |
| `structure` | `haute` | `equipes.ext_structure_id = club.id_ffhb` | équipes propres | équipes scrapées |
| `nom_exact` | `haute` | `e.nom = club.nom` | non | toujours |
| `nom_reserve` | `moyenne` | `e.nom ILIKE club.nom || ' %'` | non | toujours |
| `nom_entente` | `basse` | entente détectée **et** partage ≥ 1 token **distinctif** (après STOPWORDS) en **mot entier** (`e.nom ~* '\m' || token || '\M'`) | heuristique | toujours |

### Ordre de priorité de la confiance

`haute` > `moyenne` > `basse`. Quand plusieurs signaux matchent la même équipe, on garde la
méthode de plus haute confiance. Priorité interne entre méthodes `haute` pour `match_method` :
`licence` > `structure` > `nom_exact` (l'ordre n'affecte que l'étiquette retournée, pas
l'inclusion).

### Détection entente (`is_entente`)

Une équipe est `is_entente = true` si **l'une** des conditions est vraie :
1. **Composition** : l'équipe compte des joueurs d'au moins 2 codes club distincts
   (`count(DISTINCT left(j.numero_licence,7)) >= 2` sur `match_compositions`). Signal précis.
2. **Nom** : `e.nom ILIKE '%ENTENTE%' OR e.nom ILIKE 'ENT %' OR e.nom ILIKE '% ENT %'` (fallback
   quand pas de données FdM).

### STOPWORDS (tokens non distinctifs)

Liste de mots génériques exclus de l'extraction de tokens distinctifs du nom du club (matching
`nom_entente`) :

```
HANDBALL, HAND, HB, HBC, CLUB, ENTENTE, ENT, ASSOCIATION, ASSO, SPORT, SPORTS, SPORTING,
SPORTIVE, SPORTIVES, OMNISPORTS, OMNISPORT, US, AS, ASL, ASPTT, CS, CSL, ESL, ESP, ELAN,
AVENIR, JEUNE, JEUNES, GROUPE, GROUPEMENT, JEUNESSE, ETOILE, UNION, AMICALE, FOYER, DE, DU,
DES, LA, LE, LES, ET, SUR, EN, AUX
```

Un token est **distinctif** s'il fait ≥ 4 caractères, n'est pas dans STOPWORDS, et n'est pas
purement numérique. La couche `nom_entente` exige qu'une entente partage ≥ 1 token distinctif
en **correspondance mot-entier** (frontières de mot regex `\m…\M` côté Postgres) — ce qui élimine
les faux positifs sur mots génériques (deux clubs « X HANDBALL » et « Y HANDBALL » ne se matchent
plus mutuellement, leur seul token commun « HANDBALL » étant un STOPWORD) sans introduire de faux
négatifs (un token de ville comme « BREST » matche « ENTENTE BREST PLOUDA » en mot entier).

**Pourquoi pas un seuil trigram sur les noms complets ?** La similarité trigram entre deux noms
complets (« ENTENTE BREST PLOUDA » vs « BREST BRETAGNE HANDBALL ») tombe souvent sous 0.3 même
quand les équipes partagent une ville — un tel garde-fou produirait des **faux négatifs**. Le
matching mot-entier sur tokens distinctifs (eux-mêmes ≥ 4 chars et spécifiques) est à la fois plus
précis et plus sûr. (pg_trgm reste utilisé pour le `/search` global, hors périmètre ici.)

## Contrat API (changements additifs, rétro-compatibles)

### `equipeLieeSchema` — nouveaux champs

```ts
match_method: z.enum(["licence", "structure", "nom_exact", "nom_reserve", "nom_entente"])
confidence:   z.enum(["haute", "moyenne", "basse"])
```

`is_principal` et `is_entente` restent. `is_principal` ⟺ `match_method === "nom_exact"` (ou
`structure` exacte du club). `is_entente` suit la règle ci-dessus.

### `clubMatchsQuerySchema` — nouveau filtre optionnel

```ts
min_confidence: z.enum(["haute", "moyenne", "basse"]).optional()
```

Filtre les `equipes_liees` (et donc les matchs) à celles dont la confiance est ≥ seuil. Défaut :
absent ⇒ toutes confiances incluses (`basse`). Permet à un consommateur d'exiger uniquement les
liens autoritatifs (`min_confidence=haute`).

### `clubMatchItemSchema`

Champs inchangés (`via_entente`, `via_principal`, `club_recevant` conservés). On ajoute
`confidence` (la confiance du lien équipe↔club qui rattache ce match), pour cohérence avec
`equipes_liees`.

### Description OpenAPI

Mettre à jour la `description` de la route : remplacer « matching purement textuel via ILIKE » par
la description multi-signal (licence/structure/textuel) avec mention des niveaux de confiance.

## Fichiers touchés

- **Modify** `src/api/lib/repositories/club-matchs.repo.ts` : réécrire l'étape 2 (résolution des
  équipes) en résolveur multi-signal. Extraire `resolveLinkedTeams(opts)` →
  `EquipeLiee[]` (avec `match_method`, `confidence`). Étape 4 (matchs) inchangée hormis
  propagation de `confidence` par équipe.
- **Modify** `src/api/schemas/club-matchs.api.ts` : ajout `match_method`, `confidence`,
  `min_confidence`.
- **Modify** `src/api/routes/clubs.ts` : passer `min_confidence` ; mettre à jour description.
- **Create** `src/api/lib/club-matching.ts` : constantes (`LICENCE_MATCH_MIN_PLAYERS`,
  `STOPWORDS`) + helper `extractDistinctiveTokens(nom)` pur (testable unitairement sans DB).
- **Modify** `tests/api/routes/clubs.test.ts` : tests précision (licence, structure, faux
  positifs textuels, `min_confidence`, `include_ententes=false`, non-régression des 14 tests).
- **Create** `tests/api/lib/club-matching.test.ts` : tests unitaires `extractDistinctiveTokens`.

## Stratégie de test

1. **Couche licence** : 2 clubs A/B ; une équipe entente avec 3 licenciés A + 3 licenciés B ;
   `match_compositions` peuplées. Requête club A ⇒ entente liée (`match_method=licence`,
   `is_entente=true`) ; idem club B. Un joueur « invité » unique (1 licence A dans l'équipe propre
   de B) ne lie pas l'équipe de B au club A (seuil ≥ 3).
2. **Couche structure** : équipe avec `ext_structure_id = club.id_ffhb` ⇒ `match_method=structure`,
   `confidence=haute`.
3. **Faux positif textuel** : clubs « X HANDBALL » et « Y HANDBALL » ; l'entente « ENTENTE Y / Z »
   ne matche pas le club X (le seul token commun « HANDBALL » est un STOPWORD).
4. **`min_confidence=haute`** : exclut les liens `nom_reserve` (moyenne) et `nom_entente` (basse).
5. **`include_ententes=false`** : exclut toutes les équipes `is_entente=true`, quelle que soit la
   méthode.
6. **Non-régression** : les 14 tests existants passent (réponse enrichie de champs additifs ;
   assertions existantes non impactées).
7. **Unitaire** : `extractDistinctiveTokens("BREST BRETAGNE HANDBALL")` ⇒ `["brest", "bretagne"]`
   (HANDBALL exclu) — selon décision région : voir note ci-dessous.

## Décisions & limites

- **`BRETAGNE` dans STOPWORDS ?** Les noms de région sont ambigus : « BREST BRETAGNE HANDBALL »
  a `BRETAGNE` comme token semi-distinctif. On **n'inclut pas** les régions dans STOPWORDS (trop
  de clubs légitimes les portent) ; le garde-fou est la **correspondance mot-entier** sur tokens
  ≥ 4 chars, pas le simple substring. STOPWORDS se limite aux mots **structurels** (handball,
  club, asso…).
- **Seuil licence = 3** : constante ajustable. Compromis entre capturer les petites ententes et
  filtrer les mutations ponctuelles.
- **Dégradation gracieuse** : sans données FdM, les couches `licence` disparaissent ; sans
  `ext_structure_id` scrapé, `structure` disparaît. Le textuel raffiné reste toujours actif.
- **YAGNI** : pas de table de mapping club↔équipe matérialisée ni de résolution `club_id` dans
  l'ETL pour l'instant — la résolution reste à la lecture (endpoint). Si la volumétrie l'exige
  plus tard, on matérialisera.
