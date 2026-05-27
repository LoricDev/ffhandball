# Inventaire des champs — fiche détail club (monclub.ffhandball.fr)

> Produit par la Task 1 du plan `docs/superpowers/plans/2026-05-26-salles-implementation.md`.
> Source : exploration manuelle de 8 fiches détail, dont 3 sont conservées comme fixtures.

## Pattern URL retenu

`https://monclub.ffhandball.fr/clubs/<slug>/` (avec slash final ; suit une redirection 301
depuis la même URL sans slash).

**Note importante :** le plan initial supposait `https://www.ffhandball.fr/clubs/<id_ffhb>`.
C'était incorrect. La bonne URL est sur le sous-domaine `monclub.ffhandball.fr`, et la clé
publique est un **slug texte**, pas l'`id_ffhb` numérique. La correspondance
`slug ↔ id_ffhb` se trouve **à l'intérieur de la fiche détail** (champ `post_name`
↔ `id_club`).

**Implication pour le plan T7 (CLI scrape):** ne plus boucler sur `core.clubs.id_ffhb`,
mais sur les slugs récupérés depuis la page d'accueil `https://monclub.ffhandball.fr/`,
qui expose les ~2300 slugs publiés (dans un blob JSON embarqué, voir plus bas).

## Forme du HTML

Le site est un WordPress avec le plugin **smartfire**. Le HTML SSR est essentiellement
une coquille React vide ; **toutes les données utiles sont injectées en JSON dans
l'attribut HTML `attributes` de chaque `<smartfire-component>`** (forme HTML-échappée :
`&quot;` partout).

Composants smartfire observés sur la fiche détail :

| Component name                       | Contient                                                            |
|--------------------------------------|---------------------------------------------------------------------|
| `single-club---home-hero-club`       | **Tout** (club + gyms + licences + labels)                          |
| `single-club---licence`              | clubId (juste un pointeur React)                                    |
| `single-club---list-practices`       | Liste des pratiques (handball, beach, hand-fit…)                    |
| `single-club---hello-asso-events`    | Événements HelloAsso liés                                           |
| `licensee-guide`                     | `{ clubId }`                                                        |
| `header` / `footer`                  | Chrome WordPress                                                    |

**Conséquence majeure pour le scraper :** ne pas tenter d'extraire par sélecteurs CSS
classiques (`h1.club-name`, `.salle .nom`, etc.). À la place :

1. Cibler `smartfire-component[name='single-club---home-hero-club']`.
2. Lire l'attribut `attributes` (string HTML-échappée).
3. `cheerio.load` décode déjà `&quot;` → `"`, donc on peut directement `JSON.parse()`.
4. Naviguer dans `data.post.acf` et `data.post.post_*`.

## Champs observés

Sous `data.post` :

| Champ JSON              | Mapping `RawClubPayload`         | Fréquence    | Exemple                              |
|-------------------------|----------------------------------|--------------|--------------------------------------|
| `post_title`            | `nom`                            | toujours     | `"HANDBALL CLUB DE VIHIERS"`         |
| `post_name`             | (slug pour l'URL)                | toujours     | `"handball-club-de-vihiers"`         |
| `post_excerpt`          | = `id_club` (cf. acf.id_club)    | toujours     | `"10514"`                            |
| `post_type`             | `"smartfire-clubs"` (constante)  | toujours     | —                                    |
| `guid`                  | source_url canonique             | toujours     | `https://monclub.ffhandball.fr/clubs/handball-club-de-vihiers/` |

Sous `data.post.acf` :

| Champ JSON                       | Mapping `RawClubPayload` / `RawSallePayload`     | Fréquence sur 8 fixtures | Exemple                                                  |
|----------------------------------|---------------------------------------------------|---------------------------|----------------------------------------------------------|
| `id_club`                        | club.`id_ffhb` (string, ex `"10514"`)             | toujours (8/8)            | `"10514"`                                                |
| `club_hash`                      | (audit ; non mappé)                               | toujours                  | `"e0f6c68e588476611b5ce6ccd39e0b0e"`                     |
| `logo_club`                      | (futur : URL logo)                                | toujours                  | `"2017-08-17-c58fab3d-...png"`                           |
| `address_club`                   | club.`adresse_correspondance` (ligne 1)           | toujours (parfois vide)   | `"10 place de charles de gaulle"`                        |
| `address_club_2`                 | (à concaténer si non vide)                        | parfois                   | `"STADE LOUIS II"` ou `""`                               |
| `zipcode_club`                   | club.code_postal                                  | toujours                  | `"49310"`                                                |
| `city_club`                      | club.ville                                        | toujours                  | `"VIHIERS"` (MAJUSCULES — normaliser via `titleCaseFr`)  |
| `latitude_club` / `longitude_club` | club.lat/lng (futur : géoloc)                  | toujours                  | `"47.14515"`                                             |
| `url_club`                       | club.`site_web`                                   | souvent (5/8)             | `"http://www.hbcvihiers.fr"`                             |
| `email_club`                     | club.`email`                                      | toujours                  | `"6249073@ffhandball.net"`                               |
| `tel_club`                       | club.`telephone`                                  | parfois (5/8)             | `"0698704077"` (string, parfois sans `0` initial)        |
| `nb_licence_senior_h_club`       | (composante de `effectif_estime`)                 | toujours (parfois `"0"`)  | `"25"`                                                   |
| `nb_licence_senior_f_club`       | idem                                              | toujours                  | `"16"`                                                   |
| `nb_licence_jeunes_h_club`       | idem                                              | toujours                  | `"30"`                                                   |
| `nb_licence_jeunes_f_club`       | idem                                              | toujours                  | `"20"`                                                   |
| `register_link`                  | (URL gesthand, futur)                             | toujours                  | `"https://gesthand.net/.../inscription/10514?crtl=..."`  |
| `labels`                         | (futur : bool flags arbitrage/baby_hand/…)        | toujours (objet bool)     | `{"arbitrage":true,"baby_hand":true,…}`                  |
| `gyms_club`                      | salle (cf. ci-dessous)                            | **5/8 array, 3/8 `false`**| voir ci-dessous                                          |

Sous `data.post.acf.gyms_club[]` (array, un objet par gymnase) :

| Champ JSON      | Mapping `RawSallePayload`        | Fréquence dans l'array | Exemple                                  |
|-----------------|----------------------------------|------------------------|------------------------------------------|
| `name_gym`      | salle.nom                        | toujours               | `"LES COURTILS"` (parfois en majuscules) |
| `adress_gym`    | salle.adresse (sic, typo upstream) | toujours               | `" RUE DES COURTILS"` (espaces leading)  |
| `zipcode_gym`   | salle.code_postal                | toujours               | `"49310"`                                |
| `city_gym`      | salle.ville                      | toujours               | `"VIHIERS"`                              |
| `latitude_gym` / `longitude_gym` | (futur)                       | toujours               | `"47.14531"`                             |

**Cardinalité observée** : 0 ou 1 gym par club sur l'échantillon de 8 (jamais 2+).
Hypothèse : `gyms_club` est en pratique mono-élément ⇒ le mapping
`club.salle_principale_id = gyms_club[0]` reste valide. Mais le scraper devrait
quand même tolérer `n>1` (cas futur : prendre `[0]` comme salle principale,
ignorer le reste ou émettre un warning ETL).

## Détails et pièges

- **Le composant `single-club---home-hero-club` apparaît 2 ou 3 fois** dans le HTML
  (lazy-loaded en plusieurs blocs React). Le JSON est identique à chaque occurrence
  ⇒ il suffit de prendre le premier. Test : sur les 8 fixtures, les copies sont
  byte-identiques.
- **HTML-escaping double-niveau** : l'attribut HTML utilise `&quot;`, et les `/`
  internes aux URLs sont escapés JSON-style (`\/`). Cheerio normalise le premier,
  `JSON.parse` normalise le second.
- **`gyms_club` est `false`** (booléen) quand le club n'a déclaré aucune salle.
  C'est différent de `[]` — ce sera `false`, **pas** un array vide. Le scraper
  doit donc tester `Array.isArray(gyms_club)`, pas `gyms_club.length`.
- **`address_club_2`** est presque toujours soit la ligne 2 d'adresse (rare) soit
  une duplication du nom du club ou du complexe. Choix de mapping conservateur :
  concaténer `address_club + ' ' + address_club_2` si `address_club_2` non vide et
  non égal à `post_title`, sinon ignorer.
- **Adresse parfois en MAJUSCULES**, parfois en minuscules selon la saisie.
  Normaliser via `titleCaseFr` en ETL.
- **`tel_club` peut commencer par un chiffre non-zéro** (`"674159773"`, `"92054057"`)
  — c'est un numéro français écrit sans le `0` initial, ou un numéro Monaco. Ne pas
  reformater au scraping ; à la rigueur normaliser en ETL.
- **Pas d'`id_gym` exposé.** ⇒ Pour la natural_key des salles, fallback obligatoire
  sur slug = `lower(slugify(name_gym + '-' + zipcode_gym + '-' + city_gym))`.
- **`departement_code` n'est PAS directement exposé**. À dériver côté ETL via
  `zipcode_club.slice(0,2)` (avec corse `2A`/`2B` à gérer + DOM-TOM `97x`).
  Pour la fixture lamentinois : `97232` → `971` (Guadeloupe) ou `972` (Martinique) ?
  Lamentin = Martinique = `972`. Donc la règle est `slice(0,3)` pour `97x`, `2a/2b`
  pour la Corse, `slice(0,2)` sinon — exactement ce que fait déjà `resolve-fk` côté
  ETL (à vérifier en T8).

## Effectif estimé (mapping recommandé)

```ts
effectif_estime = sum(parseInt) of [
  nb_licence_senior_h_club,
  nb_licence_senior_f_club,
  nb_licence_jeunes_h_club,
  nb_licence_jeunes_f_club,
]
// Tomber à undefined si toutes les valeurs sont vides/null.
```

## Récap des 3 fixtures conservées

| Fixture                                       | Slug                          | id_club | Cas couvert                                                 |
|-----------------------------------------------|-------------------------------|---------|-------------------------------------------------------------|
| `ffhandball-club-detail-complet.html`         | `handball-club-de-vihiers`    | 10514   | Tous les champs présents : tel + url + email + adresse + 1 gym + licences |
| `ffhandball-club-detail-minimal.html`         | `3mt`                         | 12121   | Pas de `url_club`, peu de licences, mais 1 gym et tel présents |
| `ffhandball-club-detail-sans-salle.html`      | `beach-handball-indre`        | 12230   | `gyms_club: false`, pas de tel, pas d'url, licences null    |

## Pattern URL listing (passe 1)

Le `clubs.scraper.ts` existant suppose `tr.club-row[data-id-ffhb]` sur
`https://www.ffhandball.fr/clubs`. **Ce pattern n'existe plus** (ce path renvoie 404).
La nouvelle source des slugs est `https://monclub.ffhandball.fr/` (home), qui
contient ~2326 slugs uniques dans une blob JSON embarquée (footer/menu).

⚠️ Cette divergence justifie de remettre en question la passe 1 dans un prochain
ticket. **Hors-scope de T1.** À noter au refactor : T7 (CLI scrape `club-details`)
devra prendre une source de slugs depuis la home `monclub.ffhandball.fr/`,
pas depuis `core.clubs.id_ffhb`.

## Décisions à reporter dans le plan / les schémas

- `RawClubPayload.id_ffhb` reste `^\d+$` ✓ (id_club est `"10514"` numérique pur).
- `RawClubPayload.source_url` doit être l'URL `monclub.ffhandball.fr`, pas `www.ffhandball.fr`.
- Ajouter à `RawClubPayload` (optionnels) :
  - `slug` (= `post_name`, utile pour debug / cross-ref)
  - `latitude` / `longitude` (futur visu cartographie)
  - `register_link` (URL d'inscription gesthand)
  - `logo_club` (chemin relatif, à préfixer côté front)
- Ajouter à `RawSallePayload` (optionnels) :
  - `latitude` / `longitude`
- `nb_licence_*` → décider en T3 si on garde 4 colonnes séparées ou la somme
  `effectif_estime`. Recommandation : ajouter les 4 + la somme calculée
  (peu coûteux, débogage utile).

## TODO laissés au humain avant T2

- Décider si on étend la passe 1 (`clubs.scraper.ts`) pour pointer sur
  `monclub.ffhandball.fr` ou si on consolide tout dans la passe 2.
  → Probable : la passe 1 et la passe 2 fusionnent (un seul scraper qui itère
  sur les slugs de la home).
- Confirmer les colonnes finales de `core.clubs` (4 sous-colonnes licences vs.
  `effectif_estime` calculé) avant la migration T4.
