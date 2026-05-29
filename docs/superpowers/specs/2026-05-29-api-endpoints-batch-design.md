# Nouveaux endpoints API (batch Tiers 1-3) — Design

**Date :** 2026-05-29
**Périmètre :** ajout de ~12 endpoints REST read-only (Hono + zod-openapi), suivant les patterns
existants (`routes/*.ts` + `lib/repositories/*.repo.ts` + `schemas/*.api.ts`, rate-limit global).

Saison par défaut partout : `2025-2026`. Pagination : `limit` (1-100, défaut 20) + `offset`.
Erreurs : `errorResponseSchema` (`NOT_FOUND` 404, `BAD_REQUEST` 400).

## Tier 1 — Navigation compétitions

### `GET /competitions`
- Query : `saison`, `niveau?` (national|regional|departemental), `sexe?` (M|F|mixte), `q?` (fuzzy nom, `<%`), `limit`, `offset`.
- Item : `{ id_ffhb, nom, niveau, sexe, categorie_age, code, saison_code }`. Meta `{ total, limit, offset }`.

### `GET /competitions/:id_ffhb`
- `competitions.id_ffhb` unique global. 404 si absent.
- Data : champs compétition + `phases: [{ id_ffhb, nom, poules: [{ id_ffhb, nom }] }]`.

### `GET /poules/:id_ffhb`
- Query : `saison`. Lookup `(id_ffhb, saison_code)`. 404 si absent.
- Data : `{ id_ffhb, nom, saison_code, phase:{id_ffhb,nom}, competition:{id_ffhb,nom,niveau}, classement:[classementItem…] }` (classement inline ; matchs via `/matchs?poule_id_ffhb=`).

## Tier 2 — Équipes

### `GET /equipes/:id_ffhb`
- Query : `saison`. Lookup `(id_ffhb, saison_code)`. 404 si absent.
- Data : `{ id_ffhb, nom, saison_code, club: {id_ffhb, code_ffhb, nom} | null, engagements: [{ poule:{id_ffhb,nom}, phase:{id_ffhb,nom}, competition:{id_ffhb,nom,niveau} }] }`.
- `club` résolu via le pont **`clubs.id_ffhb = equipes.ext_structure_id`**.

### `GET /equipes/:id_ffhb/matchs`
- Query : `saison`, `date_from?`, `date_to?`, `statut?`, `limit`, `offset`. 404 si équipe absente.
- Matchs où `equipe_dom_id = equipe.id OR equipe_ext_id = equipe.id`. Item type match (réutilise la forme `/matchs`).

### `GET /clubs/:id_ffhb/equipes`
- Club résolu par `id_ffhb` OU `code_ffhb`. Query : `saison`.
- Data : `equipes: [{ id_ffhb, nom, engagements:[…] }]` — équipes propres via `ext_structure_id = club.id_ffhb`. Meta `{ club:{id_ffhb,code_ffhb,nom} }`.

## Tier 3a — Stats joueurs & historique

### `GET /stats-joueurs`
- Query : `poule_id_ffhb` (**obligatoire**), `limit`, `offset`. 400 si absent, 404 si poule/stats absentes.
- Dernier snapshot (`max(capture_date)` de la poule). Ordonné `total_buts DESC`.
- Item : `{ nom, prenom, equipe_libelle, match_count, total_buts, total_arrets }`.

### `GET /joueurs/:numero_licence/matchs`
- 404 si joueur absent. Via `match_compositions JOIN matchs`.
- Item : `{ id_ffhb_match, date_heure, statut, equipe_nom (jouée), adversaire_nom, score_equipe, score_adversaire, buts (du joueur), poule_id_ffhb, competition_nom }`.

## Tier 3b — Arbitres & salles

### `GET /arbitres`
- Query : `q?` (fuzzy `nom_complet`), `niveau?`, `limit`, `offset`.
- Item : `{ id_ffhb, numero_licence, nom_complet, nom, prenom, niveau }`. Meta.

### `GET /arbitres/:id_ffhb/matchs`
- Lookup arbitre par `id_ffhb` (unique). 404 si absent.
- Via `match_officiels JOIN matchs`. Item : `{ id_ffhb_match, date_heure, role, equipe_dom_nom, equipe_ext_nom, poule_id_ffhb, competition_nom }`.

### `GET /salles/:id_ffhb`
- 404 si absente. Data : `{ id_ffhb, nom, adresse, code_postal, ville, departement_code, capacite }`.

### `GET /salles/:id_ffhb/matchs`
- Via `matchs.salle_id = salle.id`. Filtres `saison?`/`date`/`statut` + pagination. Item type match.

## Notes
- Tous read-only, idempotents, soumis au rate-limit global.
- Réutilisation maximale : un helper de forme « match item » partagé entre /equipes/:id/matchs, /arbitres/:id/matchs, /salles/:id/matchs.
- Mise à jour README (endpoints V1 → +12) + runbook à la fin.
