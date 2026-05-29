# Précision renforcée du matching club↔équipes — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le matching textuel unique de `/clubs/:id_ffhb/matchs` par une union multi-signal (licence via compositions, structure, textuel raffiné) avec tag `match_method` + `confidence` par équipe et filtre `min_confidence`.

**Architecture:** Helper pur `club-matching.ts` (constantes + extraction de tokens distinctifs) → résolveur SQL `resolveLinkedTeams` dans le repo (CTE `comp` pour les compositions, `signals` UNION ALL des 5 méthodes, `agg` pour dédupliquer par équipe en gardant la confiance max) → schémas Zod-OpenAPI enrichis → route qui propage `min_confidence`. Index fonctionnel `left(numero_licence,7)` pour la viabilité en prod.

**Tech Stack:** TypeScript ESM, Hono + @hono/zod-openapi, pg, Postgres 16, Vitest.

**Auteur des commits :** `Loric Bondon <loric@loricdev.fr>` — **aucun** `Co-Authored-By`.

---

## Structure des fichiers

- **Create** `src/api/lib/club-matching.ts` — pur : `STOPWORDS`, `LICENCE_MATCH_MIN_PLAYERS`, types `MatchMethod`/`Confidence`, `extractDistinctiveTokens`, `buildWholeWordPattern`, `rankToConfidence`, `RANK_BY_CONFIDENCE`.
- **Create** `tests/api/lib/club-matching.test.ts` — tests unitaires (sans DB).
- **Modify** `src/api/schemas/club-matchs.api.ts` — `match_method`, `confidence` sur `equipeLieeSchema` ; `confidence` sur `clubMatchItemSchema` ; `min_confidence` sur `clubMatchsQuerySchema`.
- **Modify** `src/api/lib/repositories/club-matchs.repo.ts` — interfaces + `resolveLinkedTeams` + propagation `confidence` + filtre `min_confidence`.
- **Create** `db/migrations/0016_joueurs_licence_prefix_index.sql` — index fonctionnel.
- **Modify** `src/api/routes/clubs.ts` — passe `min_confidence`, met à jour la description OpenAPI.
- **Modify** `tests/api/routes/clubs.test.ts` — tests précision (licence, structure, faux positif, min_confidence) + non-régression.
- **Modify** `README.md`, `docs/INSTALL.md` — comptage migrations 15 → 16.

---

## Task 1: Helper pur `club-matching.ts`

**Files:**
- Create: `src/api/lib/club-matching.ts`
- Test: `tests/api/lib/club-matching.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/api/lib/club-matching.test.ts
import { describe, it, expect } from "vitest";
import {
  extractDistinctiveTokens,
  buildWholeWordPattern,
  rankToConfidence,
  STOPWORDS,
} from "@/api/lib/club-matching.js";

describe("extractDistinctiveTokens", () => {
  it("garde les tokens distinctifs et exclut les mots génériques", () => {
    expect(extractDistinctiveTokens("BREST BRETAGNE HANDBALL")).toEqual(["brest", "bretagne"]);
  });

  it("exclut les tokens < 4 caractères et purement numériques", () => {
    // "HB" (2), "92" (numérique) exclus ; "PARIS" gardé
    expect(extractDistinctiveTokens("PARIS 92 HB")).toEqual(["paris"]);
  });

  it("normalise les accents et la casse", () => {
    expect(extractDistinctiveTokens("Étoile Sportive Vénissieux")).toEqual(["venissieux"]);
  });

  it("déduplique", () => {
    expect(extractDistinctiveTokens("NANTES NANTES CLUB")).toEqual(["nantes"]);
  });

  it("retourne [] si aucun token distinctif", () => {
    expect(extractDistinctiveTokens("CLUB HANDBALL")).toEqual([]);
  });

  it("STOPWORDS contient les mots structurels clés", () => {
    expect(STOPWORDS.has("handball")).toBe(true);
    expect(STOPWORDS.has("club")).toBe(true);
    expect(STOPWORDS.has("entente")).toBe(true);
  });
});

describe("buildWholeWordPattern", () => {
  it("construit un motif regex mot-entier", () => {
    expect(buildWholeWordPattern(["brest", "bretagne"])).toBe("\\m(brest|bretagne)\\M");
  });
  it("retourne null si pas de token", () => {
    expect(buildWholeWordPattern([])).toBeNull();
  });
});

describe("rankToConfidence", () => {
  it("mappe les rangs", () => {
    expect(rankToConfidence(3)).toBe("haute");
    expect(rankToConfidence(2)).toBe("moyenne");
    expect(rankToConfidence(1)).toBe("basse");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/lib/club-matching.test.ts`
Expected: FAIL — module `@/api/lib/club-matching.js` introuvable.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/api/lib/club-matching.ts
export type MatchMethod = "licence" | "structure" | "nom_exact" | "nom_reserve" | "nom_entente";
export type Confidence = "haute" | "moyenne" | "basse";

/** Seuil de licenciés distincts du club requis pour lier une équipe via composition. */
export const LICENCE_MATCH_MIN_PLAYERS = 3;

/** Mots structurels génériques (≥ 4 chars) exclus des tokens distinctifs. */
export const STOPWORDS = new Set<string>([
  "handball", "club", "association", "asso", "sport", "sports", "sporting",
  "sportive", "sportives", "omnisports", "omnisport", "asptt", "elan", "avenir",
  "jeune", "jeunes", "jeunesse", "etoile", "union", "amicale", "foyer", "groupe",
  "groupement", "entente", "sportif", "olympique", "olympic",
]);

/** Tokens ≥ 4 chars, non-STOPWORD, non purement numériques, accents retirés, dédupliqués. */
export function extractDistinctiveTokens(nom: string): string[] {
  const tokens = nom
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !/^\d+$/.test(t));
  return [...new Set(tokens)];
}

/** Motif Postgres regex mot-entier `\m(a|b)\M`, ou null si aucun token. */
export function buildWholeWordPattern(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return `\\m(${tokens.join("|")})\\M`;
}

export const RANK_BY_CONFIDENCE: Record<Confidence, number> = { haute: 3, moyenne: 2, basse: 1 };

export function rankToConfidence(rank: number): Confidence {
  return rank >= 3 ? "haute" : rank === 2 ? "moyenne" : "basse";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/lib/club-matching.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/api/lib/club-matching.ts tests/api/lib/club-matching.test.ts
git commit -m "feat(api): helper club-matching (tokens distinctifs + STOPWORDS)"
```

---

## Task 2: Migration 0016 — index fonctionnel préfixe licence

**Files:**
- Create: `db/migrations/0016_joueurs_licence_prefix_index.sql`

- [ ] **Step 1: Write the migration**

```sql
-- db/migrations/0016_joueurs_licence_prefix_index.sql
-- Index fonctionnel sur le préfixe (7 chiffres) du numéro de licence = code club FFHB.
-- Accélère le matching licence→club de /clubs/:id_ffhb/matchs (couche "licence").
CREATE INDEX IF NOT EXISTS idx_joueurs_licence_prefix7
  ON core.joueurs (left(numero_licence, 7));
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:migrate`
Expected: aucune erreur ; l'index est créé (idempotent via `IF NOT EXISTS`).

- [ ] **Step 3: Verify the index exists**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\di core.idx_joueurs_licence_prefix7"
```
Expected: une ligne listant l'index `idx_joueurs_licence_prefix7` sur `core.joueurs`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0016_joueurs_licence_prefix_index.sql
git commit -m "feat(db): index fonctionnel left(numero_licence,7) pour matching licence→club"
```

---

## Task 3: Schémas API enrichis

**Files:**
- Modify: `src/api/schemas/club-matchs.api.ts`

- [ ] **Step 1: Add `match_method` + `confidence` to `equipeLieeSchema`**

Dans `equipeLieeSchema`, après le champ `is_entente`, ajouter :

```ts
    match_method: z
      .enum(["licence", "structure", "nom_exact", "nom_reserve", "nom_entente"])
      .openapi({
        description:
          "Méthode de détection du lien : licence (≥3 licenciés du club ont joué pour l'équipe), structure (ext_structure_id), nom_exact, nom_reserve, nom_entente",
        example: "nom_exact",
      }),
    confidence: z.enum(["haute", "moyenne", "basse"]).openapi({
      description: "Confiance du lien : haute (licence/structure/nom_exact), moyenne (nom_reserve), basse (nom_entente)",
      example: "haute",
    }),
```

- [ ] **Step 2: Add `confidence` to `clubMatchItemSchema`**

Dans `clubMatchItemSchema`, après le champ `via_principal`, ajouter :

```ts
    confidence: z.enum(["haute", "moyenne", "basse"]).openapi({
      description: "Confiance du lien équipe↔club qui rattache ce match au club",
      example: "haute",
    }),
```

- [ ] **Step 3: Add `min_confidence` to `clubMatchsQuerySchema`**

Dans `clubMatchsQuerySchema`, après le champ `statut`, ajouter :

```ts
  min_confidence: z
    .enum(["haute", "moyenne", "basse"])
    .optional()
    .openapi({
      description:
        "Filtre les équipes liées (et leurs matchs) par confiance minimale. Absent = toutes confiances.",
      example: "haute",
    }),
```

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (les nouveaux champs ne cassent rien ; le repo sera mis à jour en Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/api/schemas/club-matchs.api.ts
git commit -m "feat(api): schémas match_method/confidence/min_confidence (club matchs)"
```

> Note : si `tsc --noEmit` signale que `getClubMatchsCalendar` ne fournit pas encore `match_method`/`confidence`, c'est attendu — le repo est mis à jour en Task 4. Le typecheck final vert est exigé à la fin de Task 4, pas ici. Committer quand même les schémas.

---

## Task 4: Résolveur multi-signal dans le repo

**Files:**
- Modify: `src/api/lib/repositories/club-matchs.repo.ts`
- Test: `tests/api/lib/repositories/club-matchs.repo.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Créer `tests/api/lib/repositories/club-matchs.repo.test.ts`. Ce test seed directement la DB et appelle `getClubMatchsCalendar`. Il utilise des codes club **numériques 7 chiffres** pour exercer la couche licence.

```ts
// tests/api/lib/repositories/club-matchs.repo.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { getClubMatchsCalendar } from "@/api/lib/repositories/club-matchs.repo.js";

const SAISON = "2025-2026";
const CLUB_A = "5655011"; // entente member A
const CLUB_B = "6275001"; // entente member B

let pouleId: bigint;
let equipeEntenteId: bigint;
let equipeStructId: bigint;
let equipeAdvId: bigint;

async function seedJoueur(licence: string, nom: string): Promise<bigint> {
  const r = await query<{ id: bigint }>(
    `INSERT INTO core.joueurs (numero_licence, nom, prenom)
     VALUES ($1, $2, 'X')
     ON CONFLICT (numero_licence) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [licence, nom],
  );
  return r.rows[0]!.id;
}

async function addComposition(matchId: bigint, joueurId: bigint, equipeId: bigint): Promise<void> {
  await query(
    `INSERT INTO core.match_compositions (match_id, joueur_id, equipe_id)
     VALUES ($1, $2, $3) ON CONFLICT (match_id, joueur_id) DO NOTHING`,
    [matchId, joueurId, equipeId],
  );
}

beforeAll(async () => {
  // Nettoyage ciblé
  await query(`DELETE FROM core.match_compositions WHERE joueur_id IN (SELECT id FROM core.joueurs WHERE numero_licence LIKE '5655011%' OR numero_licence LIKE '6275001%')`);
  await query(`DELETE FROM core.matchs WHERE id_ffhb_match LIKE 'PREC-M-%'`);
  await query(`DELETE FROM core.equipes WHERE id_ffhb LIKE 'PREC-EQ-%' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.poules WHERE id_ffhb = 'PREC-PO' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.phases WHERE id_ffhb = 'PREC-PH' AND saison_code = $1`, [SAISON]);
  await query(`DELETE FROM core.competitions WHERE id_ffhb = 'PREC-COMP'`);
  await query(`DELETE FROM core.clubs WHERE id_ffhb IN ($1, $2)`, [CLUB_A, CLUB_B]);
  await query(`DELETE FROM core.joueurs WHERE numero_licence LIKE '5655011%' OR numero_licence LIKE '6275001%'`);

  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-09-01', '2026-06-30') ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
  await query(
    `INSERT INTO core.clubs (id_ffhb, nom, last_seen_at) VALUES
       ($1, 'CLUB ALPHA HANDBALL', now()), ($2, 'CLUB BETA HANDBALL', now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
    [CLUB_A, CLUB_B],
  );
  const comp = await query<{ id: bigint }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code, last_seen_at)
     VALUES ('PREC-COMP', 'Comp Prec', 'national', $1, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const ph = await query<{ id: bigint }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
     VALUES ('PREC-PH', $1, 'Ph', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const po = await query<{ id: bigint }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
     VALUES ('PREC-PO', $1, 'Po', $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [ph.rows[0]!.id, SAISON],
  );
  pouleId = po.rows[0]!.id;

  // Équipes
  const ent = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('PREC-EQ-ENT', 'ENTENTE GAMMA DELTA', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  equipeEntenteId = ent.rows[0]!.id;
  const struct = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, ext_structure_id, saison_code, last_seen_at)
     VALUES ('PREC-EQ-STR', 'EQUIPE STRUCT ALPHA', $1, $2, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET ext_structure_id = EXCLUDED.ext_structure_id RETURNING id`,
    [CLUB_A, SAISON],
  );
  equipeStructId = struct.rows[0]!.id;
  const adv = await query<{ id: bigint }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
     VALUES ('PREC-EQ-ADV', 'ADVERSAIRE NEUTRE', $1, now())
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  equipeAdvId = adv.rows[0]!.id;

  // Match de l'entente (à domicile) + match de l'équipe structure
  const m1 = await query<{ id: bigint }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut)
     VALUES ('PREC-M-001', $1, $2, $3, '2025-10-01T20:00:00Z', 'joue')
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut RETURNING id`,
    [pouleId, equipeEntenteId, equipeAdvId],
  );
  await query(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, statut)
     VALUES ('PREC-M-002', $1, $2, $3, '2025-10-08T20:00:00Z', 'joue')
     ON CONFLICT (id_ffhb_match) DO UPDATE SET statut = EXCLUDED.statut`,
    [pouleId, equipeStructId, equipeAdvId],
  );

  // Compositions : 3 licenciés A + 3 licenciés B dans l'entente → n_distinct_clubs=2
  for (let i = 1; i <= 3; i++) {
    const jA = await seedJoueur(`5655011${100000 + i}`, `JOUEUR_A${i}`);
    const jB = await seedJoueur(`6275001${100000 + i}`, `JOUEUR_B${i}`);
    await addComposition(m1.rows[0]!.id, jA, equipeEntenteId);
    await addComposition(m1.rows[0]!.id, jB, equipeEntenteId);
  }
});

describe("getClubMatchsCalendar — couches de précision", () => {
  it("lie l'entente au club A via la couche licence (≥3 licenciés) avec is_entente", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_A, saison: SAISON, include_ententes: true, limit: 50, offset: 0,
    });
    const ent = r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA");
    expect(ent).toBeDefined();
    expect(ent!.match_method).toBe("licence");
    expect(ent!.confidence).toBe("haute");
    expect(ent!.is_entente).toBe(true);
    // Le club A est aussi lié à son équipe structure
    const str = r.equipes_liees.find((e) => e.nom === "EQUIPE STRUCT ALPHA");
    expect(str!.match_method).toBe("structure");
    // Les matchs incluent celui de l'entente
    expect(r.matchs.map((m) => m.id_ffhb_match)).toContain("PREC-M-001");
  });

  it("lie l'entente au club B aussi (ses licenciés y ont joué)", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_B, saison: SAISON, include_ententes: true, limit: 50, offset: 0,
    });
    expect(r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA")).toBeDefined();
  });

  it("ne lie PAS l'entente quand min_confidence=haute exclut le textuel mais garde la licence", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_A, saison: SAISON, include_ententes: true, min_confidence: "haute", limit: 50, offset: 0,
    });
    // licence + structure sont haute → conservées
    expect(r.equipes_liees.every((e) => e.confidence === "haute")).toBe(true);
    expect(r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA")).toBeDefined();
  });

  it("exclut l'entente quand include_ententes=false", async () => {
    const r = await getClubMatchsCalendar({
      id_ffhb: CLUB_A, saison: SAISON, include_ententes: false, limit: 50, offset: 0,
    });
    expect(r.equipes_liees.find((e) => e.nom === "ENTENTE GAMMA DELTA")).toBeUndefined();
    // structure (non-entente) reste
    expect(r.equipes_liees.find((e) => e.nom === "EQUIPE STRUCT ALPHA")).toBeDefined();
  });

  afterAll(async () => {
    await closePool();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/lib/repositories/club-matchs.repo.test.ts --no-file-parallelism --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL — `match_method`/`confidence` absents (le repo retourne encore l'ancienne forme) et la couche licence n'existe pas.

- [ ] **Step 3: Update interfaces in `club-matchs.repo.ts`**

En haut du fichier, après les imports, ajouter l'import du helper et étendre les interfaces :

```ts
import { query } from "@/db/client.js";
import {
  extractDistinctiveTokens,
  buildWholeWordPattern,
  rankToConfidence,
  RANK_BY_CONFIDENCE,
  LICENCE_MATCH_MIN_PLAYERS,
  type MatchMethod,
  type Confidence,
} from "@/api/lib/club-matching.js";
```

Étendre `EquipeLiee` :

```ts
export interface EquipeLiee {
  id: bigint;
  id_ffhb: string;
  nom: string;
  is_principal: boolean;
  is_entente: boolean;
  match_method: MatchMethod;
  confidence: Confidence;
}
```

Étendre `ClubMatchItem` (ajouter `confidence`) :

```ts
  via_principal: boolean;
  confidence: Confidence;
}
```

Étendre `ClubMatchsOptions` (ajouter `min_confidence`) :

```ts
  statut?: string;
  min_confidence?: Confidence;
  limit: number;
  offset: number;
}
```

- [ ] **Step 4: Replace the equipes-resolution block with `resolveLinkedTeams`**

Remplacer tout le bloc « 2. Récupérer les équipes liées… » (l'ancien `equipesSql` + son `query`) par un appel à un nouveau helper privé. Juste après avoir obtenu `club` (étape 1), remplacer par :

```ts
  // 2. Résolution multi-signal des équipes liées (licence + structure + textuel)
  const equipes_liees = await resolveLinkedTeams(
    club,
    opts.saison,
    opts.include_ententes,
    opts.min_confidence,
  );

  if (equipes_liees.length === 0) {
    return { club, equipes_liees: [], matchs: [], total: 0 };
  }
```

Puis, à la fin du fichier (après `getClubMatchsCalendar`), ajouter la fonction :

```ts
async function resolveLinkedTeams(
  club: { id_ffhb: string; nom: string },
  saison: string,
  include_ententes: boolean,
  min_confidence?: Confidence,
): Promise<EquipeLiee[]> {
  const pattern = buildWholeWordPattern(extractDistinctiveTokens(club.nom)); // string | null
  const minRank = min_confidence ? RANK_BY_CONFIDENCE[min_confidence] : null;

  const sql = `
    WITH comp AS (
      SELECT mc.equipe_id,
             count(DISTINCT j.id) FILTER (WHERE left(j.numero_licence, 7) = $1) AS n_club_players,
             count(DISTINCT left(j.numero_licence, 7)) AS n_distinct_clubs
        FROM core.match_compositions mc
        JOIN core.joueurs j ON j.id = mc.joueur_id
       WHERE mc.equipe_id IN (
         SELECT mc2.equipe_id
           FROM core.match_compositions mc2
           JOIN core.joueurs j2 ON j2.id = mc2.joueur_id
          WHERE left(j2.numero_licence, 7) = $1
       )
       GROUP BY mc.equipe_id
    ),
    signals AS (
      SELECT e.id, 'licence'::text AS method, 3 AS conf_rank
        FROM core.equipes e JOIN comp ON comp.equipe_id = e.id
       WHERE e.saison_code = $2 AND comp.n_club_players >= $3
      UNION ALL
      SELECT e.id, 'structure', 3
        FROM core.equipes e
       WHERE e.saison_code = $2 AND e.ext_structure_id = $1
      UNION ALL
      SELECT e.id, 'nom_exact', 3
        FROM core.equipes e
       WHERE e.saison_code = $2 AND e.nom = $4
      UNION ALL
      SELECT e.id, 'nom_reserve', 2
        FROM core.equipes e
       WHERE e.saison_code = $2 AND e.nom ILIKE $4 || ' %'
      UNION ALL
      SELECT e.id, 'nom_entente', 1
        FROM core.equipes e
       WHERE e.saison_code = $2
         AND $5::text IS NOT NULL
         AND e.nom ~* $5
         AND (e.nom ILIKE '%ENTENTE%' OR e.nom ILIKE 'ENT %' OR e.nom ILIKE '% ENT %')
    ),
    agg AS (
      SELECT e.id, e.id_ffhb, e.nom,
             max(s.conf_rank) AS conf_rank,
             (array_agg(s.method ORDER BY s.conf_rank DESC,
                CASE s.method
                  WHEN 'licence' THEN 1 WHEN 'structure' THEN 2 WHEN 'nom_exact' THEN 3
                  WHEN 'nom_reserve' THEN 4 ELSE 5 END))[1] AS match_method,
             bool_or(s.method = 'nom_exact') AS is_principal,
             (bool_or(e.nom ILIKE '%ENTENTE%' OR e.nom ILIKE 'ENT %' OR e.nom ILIKE '% ENT %')
               OR COALESCE(max(comp.n_distinct_clubs), 0) >= 2) AS is_entente
        FROM signals s
        JOIN core.equipes e ON e.id = s.id
        LEFT JOIN comp ON comp.equipe_id = e.id
       GROUP BY e.id, e.id_ffhb, e.nom
    )
    SELECT id, id_ffhb, nom, conf_rank, match_method, is_principal, is_entente
      FROM agg
     WHERE ($6 = true OR is_entente = false)
       AND ($7::int IS NULL OR conf_rank >= $7)
     ORDER BY nom
  `;

  const res = await query<{
    id: bigint;
    id_ffhb: string;
    nom: string;
    conf_rank: number;
    match_method: MatchMethod;
    is_principal: boolean;
    is_entente: boolean;
  }>(sql, [
    club.id_ffhb,
    saison,
    LICENCE_MATCH_MIN_PLAYERS,
    club.nom,
    pattern,
    include_ententes,
    minRank,
  ]);

  return res.rows.map((r) => ({
    id: r.id,
    id_ffhb: r.id_ffhb,
    nom: r.nom,
    is_principal: r.is_principal,
    is_entente: r.is_entente,
    match_method: r.match_method,
    confidence: rankToConfidence(r.conf_rank),
  }));
}
```

- [ ] **Step 5: Propagate `confidence` in match enrichment**

Dans le `.map((row) => { … })` final de `getClubMatchsCalendar`, ajouter `confidence` à l'objet retourné, calculé depuis l'équipe liée matchée :

```ts
    return {
      id_ffhb_match: row.id_ffhb_match,
      date_heure: row.date_heure,
      statut: row.statut,
      journee: row.journee,
      equipe_dom_nom: row.equipe_dom_nom,
      equipe_ext_nom: row.equipe_ext_nom,
      score_dom: row.score_dom,
      score_ext: row.score_ext,
      poule_id_ffhb: row.poule_id_ffhb,
      competition_nom: row.competition_nom,
      fdm_url: row.fdm_url,
      club_recevant: !!domEquipe,
      via_entente: matchedEquipe?.is_entente ?? false,
      via_principal: matchedEquipe?.is_principal ?? false,
      confidence: matchedEquipe?.confidence ?? "basse",
    };
```

- [ ] **Step 6: Run the precision test to verify it passes**

Run: `npx vitest run tests/api/lib/repositories/club-matchs.repo.test.ts --no-file-parallelism --pool=forks --poolOptions.forks.singleFork`
Expected: PASS (4 cas).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (toutes les interfaces alignées).

- [ ] **Step 8: Commit**

```bash
git add src/api/lib/repositories/club-matchs.repo.ts tests/api/lib/repositories/club-matchs.repo.test.ts
git commit -m "feat(api): résolveur multi-signal club↔équipes (licence/structure/textuel + confidence)"
```

---

## Task 5: Wiring route + non-régression HTTP

**Files:**
- Modify: `src/api/routes/clubs.ts`
- Modify: `tests/api/routes/clubs.test.ts`

- [ ] **Step 1: Add a failing HTTP-level precision test**

Dans `tests/api/routes/clubs.test.ts`, à l'intérieur du `describe("GET /clubs/:id_ffhb/matchs", …)`, ajouter deux tests. Le premier vérifie la non-régression des nouveaux champs ; le second vérifie le **faux positif corrigé** (mot générique HANDBALL ne lie plus). Ajouter après le test `"meta.equipes_liees lists detected teams with correct flags"` :

```ts
  it("expose match_method et confidence sur les équipes liées", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: { equipes_liees: { nom: string; match_method: string; confidence: string }[] };
    };
    const principal = body.meta.equipes_liees.find((e) => e.nom === "BREST BRETAGNE HANDBALL")!;
    expect(principal.match_method).toBe("nom_exact");
    expect(principal.confidence).toBe("haute");
    const reserve = body.meta.equipes_liees.find((e) => e.nom === "BREST BRETAGNE HANDBALL 2")!;
    expect(reserve.match_method).toBe("nom_reserve");
    expect(reserve.confidence).toBe("moyenne");
  });

  it("ne lie pas une entente partageant seulement un mot générique (HANDBALL)", async () => {
    // Club au nom générique + entente sans token distinctif commun
    await query(
      `INSERT INTO core.clubs (id_ffhb, nom, last_seen_at)
       VALUES ('CAL-C003', 'ALPHACITY HANDBALL', now())
       ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom`,
    );
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code, last_seen_at)
       VALUES ('CAL-EQ-FP', 'ENTENTE HANDBALL BETAVILLE', '2025-2026', now())
       ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom`,
    );
    const res = await app.request("/clubs/CAL-C003/matchs?saison=2025-2026");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { equipes_liees: { nom: string }[] } };
    expect(body.meta.equipes_liees.find((e) => e.nom === "ENTENTE HANDBALL BETAVILLE")).toBeUndefined();
  });

  it("min_confidence=haute exclut les réserves (moyenne)", async () => {
    const res = await app.request("/clubs/CAL-C001/matchs?saison=2025-2026&min_confidence=haute");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { equipes_liees: { nom: string; confidence: string }[] } };
    expect(body.meta.equipes_liees.every((e) => e.confidence === "haute")).toBe(true);
    expect(body.meta.equipes_liees.find((e) => e.nom === "BREST BRETAGNE HANDBALL 2")).toBeUndefined();
  });
```

Ajouter aussi le nettoyage de `CAL-C003` / `CAL-EQ-FP` dans le `beforeAll` (bloc de nettoyage en tête du `describe`) :

```ts
    await query(`DELETE FROM core.equipes WHERE id_ffhb = 'CAL-EQ-FP' AND saison_code = '2025-2026'`);
    await query(`DELETE FROM core.clubs WHERE id_ffhb = 'CAL-C003'`);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api/routes/clubs.test.ts --no-file-parallelism --pool=forks --poolOptions.forks.singleFork`
Expected: FAIL — `min_confidence` non passé au repo (filtre ignoré) ; champs `match_method`/`confidence` peuvent déjà être présents (repo OK depuis Task 4) mais le filtre `min_confidence` ne s'applique pas encore.

- [ ] **Step 3: Pass `min_confidence` in the route handler**

Dans `src/api/routes/clubs.ts`, dans l'appel `getClubMatchsCalendar({ … })`, ajouter `min_confidence` :

```ts
  const result = await getClubMatchsCalendar({
    id_ffhb,
    saison: q.saison,
    include_ententes: q.include_ententes,
    date_from: q.date_from,
    date_to: q.date_to,
    statut: q.statut,
    min_confidence: q.min_confidence,
    limit: q.limit,
    offset: q.offset,
  });
```

- [ ] **Step 4: Update the OpenAPI route description**

Remplacer le tableau `description: [ … ].join("\n")` du `clubMatchsRoute` par :

```ts
  description: [
    "Retourne les matchs d'un club pour une saison donnée. Les équipes liées sont détectées",
    "via une **union multi-signal**, chaque équipe taggée `match_method` + `confidence` :",
    "- `licence` (haute) : ≥ 3 licenciés du club ont joué pour l'équipe (capture les ententes via les feuilles de match)",
    "- `structure` (haute) : `equipes.ext_structure_id` = code club",
    "- `nom_exact` (haute) : nom d'équipe = nom du club",
    "- `nom_reserve` (moyenne) : nom du club + suffixe (« X 2 », « X U17 »…)",
    "- `nom_entente` (basse) : entente partageant un mot distinctif (hors mots génériques) avec le club",
    "",
    "`include_ententes=false` exclut les équipes ententes. `min_confidence` filtre par confiance minimale.",
    "Le champ `meta.equipes_liees` détaille chaque lien (transparence et debug).",
  ].join("\n"),
```

- [ ] **Step 5: Run the route tests to verify they pass**

Run: `npx vitest run tests/api/routes/clubs.test.ts --no-file-parallelism --pool=forks --poolOptions.forks.singleFork`
Expected: PASS — les 14 tests existants + 3 nouveaux.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/clubs.ts tests/api/routes/clubs.test.ts
git commit -m "feat(api): /clubs/:id_ffhb/matchs expose match_method/confidence + filtre min_confidence"
```

---

## Task 6: Suite complète + documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/INSTALL.md`

- [ ] **Step 1: Run the full test suite (sequential)**

Run: `npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork`
Expected: PASS — tous les tests (~250 + nouveaux). Aucune régression.

- [ ] **Step 2: Update migration count in README**

Dans `README.md`, remplacer les occurrences de comptage migrations : « 15 migrations » → « 16 migrations » (ligne Stack/structure et la ligne Statut « 15 migrations »). Mettre à jour la ligne Statut finale :
`**17 entités modèle • 16 migrations • 10 scrapers • 13 ETLs • 9 endpoints API • ~250 tests passants**`

- [ ] **Step 3: Update migration count in INSTALL**

Dans `docs/INSTALL.md`, remplacer « Applique toutes les migrations 0001 → 0015 » → « 0001 → 0016 » et toute mention « 15 migrations » → « 16 migrations ».

- [ ] **Step 4: Commit**

```bash
git add README.md docs/INSTALL.md
git commit -m "docs: comptage migrations 16 + matching multi-signal"
```

---

## Self-Review (rédacteur du plan)

- **Couverture spec :** licence ✅ (T4 comp CTE), structure ✅ (T4 signals), nom_exact/réserve/entente ✅ (T4), STOPWORDS+mot-entier ✅ (T1+T4), `match_method`/`confidence` ✅ (T3+T4), `min_confidence` ✅ (T3+T5), is_entente composition+nom ✅ (T4), index perf ✅ (T2), non-régression ✅ (T5+T6).
- **Placeholders :** aucun — tout le code est fourni intégralement.
- **Cohérence des types :** `MatchMethod`/`Confidence` définis en T1, importés en T3 (schémas via `z.enum` littéraux identiques) et T4 (repo). `rankToConfidence`/`RANK_BY_CONFIDENCE`/`LICENCE_MATCH_MIN_PLAYERS`/`buildWholeWordPattern`/`extractDistinctiveTokens` définis en T1, consommés en T4. `resolveLinkedTeams` signature alignée avec son appel.
- **Risque connu géré :** pas de seuil trigram (faux négatifs) — matching mot-entier `\m…\M`. Codes club non-numériques (fixtures `CAL-*`) → `left(licence,7)` ne matche jamais → couches licence/structure inertes, textuel inchangé → 14 tests existants verts.
