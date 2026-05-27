# Champs disponibles — ffhandball.fr compétitions

## /competitions/ (home)
- Composant `competitions---saison-selector` → champ `ext_saisonId` (ex: `"21"` pour 2025-2026)
- Le libellé de la saison est de la forme `"2025 - 2026"` (avec espaces autour du tiret)
- La redirection `/competitions/` → `/competitions/saison-YYYY-YYYY-{ext_saisonId}/` confirme l'ext_saisonId

## /<niveau>/ (pages liste)

### Composant `competitions---competition-main-menu` :

**Champs compétitions** (`competitions[]`) :
- `ext_competitionId` — natural key (string)
- `id` — id interne
- `libelle` — nom complet (ex: `"LIGUE BUTAGAZ ENERGIE 2025-26"`)
- `genre` — `FEMININ` | `MASCULIN` | `MIXTE`
- `type` — `NATIONAL` | `REGIONAL` | `DEPARTEMENTAL` | `COUPE_DE_FRANCE` | `INTER_LIGUES` | `INTER_COMITES`
- `code` — ex: `"001"`
- `structureId` — id interne de la structure (ex: `"1"` pour national, `"4"` pour ligue ARA)
- `saisonId` — id interne de la saison
- `logo` — nom court du logo (ex: `"D1F"`, `"N3M"`)
- `dateDernierUpdateEnfants` — timestamp dernière MAJ
- `afficherStatsJoueurs` — `"0"` | `"1"`

**Champs structures** (`structures[]`) — présents sur les pages /regional/ et /departemental/ :
- `ext_structureId` — natural key (string)
- `id` — id interne
- `libelle` — nom complet (ex: `"LIGUE AUVERGNE-RHONE-ALPES"`)
- `sigle` — ex: `"AURAHB"`
- `code` — ex: `"5100000"`
- `type` — `"LIG"` (ligue) | `"COM"` (comité)
- `libelleCourt` — ex: `"51-AUVERGNE-RHONE-ALPES"`
- `oldUrl` — ex: `"L51"` (identifiant legacy, non utilisé dans les URLs actuelles)
- `latitude`, `longitude` — coordonnées géographiques
- (+ champs contact : `email`, `telephone`, `urlSite`, `facebook`, `instagram`, `twitter`, `tiktok`, `youtube`, `linkedIn`)

**Champ de contexte** :
- `ext_saison_id` — id de la saison courante
- `url_competition_type` — `"national"` | `"regional"` | `"departemental"`
- `competitions[]` — vide sur les pages /regional/ et /departemental/ root (rempli uniquement sur les pages per-structure)

## /<niveau>/<slug>/ (page détail compétition)

### Composant `competitions---poule-selector` :

**Champs phases** (`phases[]`) :
- `ext_phaseId` — natural key (string)
- `id` — id interne (référencé par `poules[].phaseId`)
- `competitionId` — id interne de la compétition
- `libelle` — nom de la phase (ex: `"LIGUE BUTAGAZ ENERGIE"`, `"N3M"`)
- `dateDernierUpdateEnfants` — timestamp dernière MAJ
- `classement` — données de classement (JSON)

**Champs poules** (`poules[]`) :
- `ext_pouleId` — natural key (string)
- `id` — id interne
- `phaseId` — id interne → mapping vers `phases[].id` → `phases[].ext_phaseId`
- `libelle` — nom (ex: `"POULE UNIQUE"`, `"POULE 1"`, ..., `"POULE 8"`)
- `phase_competitionId` — id interne compétition (copie de `phases[].competitionId`)
- `journees` — JSON stringifiée des journées — **IGNORÉ dans cette feature**
- `dateDernierUpdateEnfants` — timestamp dernière MAJ

## Pattern URL per-structure (validé en T1)

**CONFIRMÉ** : `o-{slugify(libelle)}-{ext_structureId}/`

```
/regional/o-ligue-auvergne-rhone-alpes-4/      (LIGUE AUVERGNE-RHONE-ALPES, id=4)
/regional/o-ligue-grand-est-de-handball-2/     (LIGUE GRAND EST DE HANDBALL, id=2)
/departemental/o-comite-de-l-ain-34/           (COMITE DE L'AIN, id=34)
/departemental/o-comite-des-alpes-maritimes-155/
```

**Règle `slugify`** : `lower → NFD normalize → strip accents → [^a-z0-9]+ → "-" → strip edges`

**Note importante :** Le préfixe `o-` est obligatoire. Les URLs sans ce préfixe retournent **404**.
Le préfixe provient du type WordPress "organisation" (type=LIG ou type=COM).

## Statistiques (saison 2025-2026, ext_saison_id=21)

| Niveau | Structures | Compétitions (exemple) |
|--------|-----------|------------------------|
| national | 0 (pas de structure) | 20 compétitions |
| regional | 19 ligues | 32 (LIGUE ARA) |
| departemental | 85 comités | variable |

## Compétitions fixture multi-poules

NATIONALE 3 MASCULINE 2025-26 (`ext_competitionId=28559`) :
- URL : `/competitions/saison-2025-2026-21/national/nationale-3-masculine-2025-26-28559/`
- 1 phase : `N3M` (ext_phaseId=97235)
- 8 poules : POULE 1 à POULE 8

## Saison selector

La saison 2025-2026 a le libellé `"2025 - 2026"` (espaces entourant le tiret) dans le composant
`competitions---saison-selector`. Pour normaliser en code `"2025-2026"`, il faut effectuer
`.replace(" - ", "-")` ou comparer après `.replace(/\s/g, "")`.
