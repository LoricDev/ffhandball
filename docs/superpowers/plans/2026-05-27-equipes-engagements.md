# Équipes & engagements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extraire les équipes engagées en compétition et leur lien many-to-many vers les poules depuis les pages détail compétition de ffhandball.fr, alimenter `core.equipes` (club_id NULL) et `core.engagements`.

**Architecture:** Étendre `parseCompetitionDetail` pour extraire les équipes depuis `competitions---calendar-button` (avec fallback `competitions---poule-selector.equipe_options[]`). Insertion dans 2 nouvelles raw tables (`raw.engagements` créée, `raw.equipes` déjà existante depuis migration 0001), puis 2 ETLs (equipes → engagements) avec résolution FK poule et FK équipe.

**Tech Stack:** TypeScript 5.7, Cheerio, Zod, Postgres 16, Vitest, tsx (pattern déjà établi par `competitions`).

**Spec:** `docs/superpowers/specs/2026-05-27-equipes-engagements-design.md`

**Pré-requis** : la branche `feat/equipes-engagements` est créée depuis master (déjà fait). `core.competitions/phases/poules` sont peuplés (depuis le smoke test T11 de la feature précédente, ~1990 competitions, 7 phases, 7 poules — suffisant pour le smoke test final).

---

### Task 1: Schémas Zod equipe + engagement

**Files:**
- Create: `src/schemas/equipe.schema.ts`
- Create: `src/schemas/engagement.schema.ts`
- Create: `tests/schemas/equipe.schema.test.ts`
- Create: `tests/schemas/engagement.schema.test.ts`

- [ ] **Step 1.1 : Tests equipe.schema (failing)**

```ts
// tests/schemas/equipe.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawEquipePayloadSchema } from "@/schemas/equipe.schema.js";

describe("rawEquipePayloadSchema", () => {
  it("accepts a complete payload", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      nom: "BREST BRETAGNE HANDBALL",
      ext_structure_id: "1720",
      logo: "2023-06-13-aaa.jpg",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
    });
    expect(r.success).toBe(true);
  });

  it("accepts payload without optional fields (fallback case)", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty ext_equipe_id", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects missing nom", () => {
    const r = rawEquipePayloadSchema.safeParse({
      ext_equipe_id: "1",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 1.2 : Run failing**

```bash
npx vitest run tests/schemas/equipe.schema.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 1.3 : Implémentation equipe.schema**

```ts
// src/schemas/equipe.schema.ts
import { z } from "zod";

export const rawEquipePayloadSchema = z.object({
  ext_equipe_id: z.string().min(1),
  nom: z.string().min(1),
  ext_structure_id: z.string().optional(),
  logo: z.string().optional(),
  source_url: z.string().url(),
});
export type RawEquipePayload = z.infer<typeof rawEquipePayloadSchema>;
```

- [ ] **Step 1.4 : Run passing**

```bash
npx vitest run tests/schemas/equipe.schema.test.ts
```

Expected: 4 passed.

- [ ] **Step 1.5 : Tests engagement.schema + implémentation**

```ts
// tests/schemas/engagement.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawEngagementPayloadSchema } from "@/schemas/engagement.schema.js";

describe("rawEngagementPayloadSchema", () => {
  it("accepts a valid engagement payload", () => {
    const r = rawEngagementPayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      ext_poule_id: "168256",
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when ext_poule_id is missing", () => {
    const r = rawEngagementPayloadSchema.safeParse({
      ext_equipe_id: "1949474",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty ext_equipe_id", () => {
    const r = rawEngagementPayloadSchema.safeParse({
      ext_equipe_id: "",
      ext_poule_id: "1",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
```

```ts
// src/schemas/engagement.schema.ts
import { z } from "zod";

export const rawEngagementPayloadSchema = z.object({
  ext_equipe_id: z.string().min(1),
  ext_poule_id: z.string().min(1),
  source_url: z.string().url(),
});
export type RawEngagementPayload = z.infer<typeof rawEngagementPayloadSchema>;
```

```bash
npx vitest run tests/schemas/engagement.schema.test.ts
```

Expected: 3 passed.

- [ ] **Step 1.6 : Commit**

```bash
git add src/schemas/equipe.schema.ts src/schemas/engagement.schema.ts \
        tests/schemas/equipe.schema.test.ts tests/schemas/engagement.schema.test.ts
git commit -m "$(cat <<'EOF'
feat: schémas Zod equipe + engagement

T1 : payloads raw pour les 2 nouvelles entités du pipeline.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0009

**Files:**
- Create: `db/migrations/0009_equipes_engagements.sql`

- [ ] **Step 2.1 : Pré-vérification de l'état actuel**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.equipes"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.engagements"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt raw.engagements"
```

Confirmer :
- `core.equipes` a `club_id NOT NULL`, `nom_equipe`, `sexe NOT NULL`, `categorie_age NOT NULL`, contrainte `uq_equipes_club_nom_saison`
- `core.engagements` existe avec `(equipe_id FK, poule_id FK, PK composite)`
- `raw.engagements` n'existe PAS encore

- [ ] **Step 2.2 : Écrire la migration**

```sql
-- db/migrations/0009_equipes_engagements.sql

-- 1. Raw table additionnelle (raw.equipes existe déjà depuis migration 0001)
SELECT raw._create_capture_table('engagements');

-- 2. Alter core.equipes
ALTER TABLE core.equipes DROP CONSTRAINT IF EXISTS uq_equipes_club_nom_saison;
ALTER TABLE core.equipes ALTER COLUMN club_id DROP NOT NULL;
ALTER TABLE core.equipes ALTER COLUMN sexe DROP NOT NULL;
ALTER TABLE core.equipes ALTER COLUMN categorie_age DROP NOT NULL;
ALTER TABLE core.equipes RENAME COLUMN nom_equipe TO nom;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS ext_structure_id TEXT;
ALTER TABLE core.equipes ADD COLUMN IF NOT EXISTS logo TEXT;

ALTER TABLE core.equipes ADD CONSTRAINT uq_equipes_id_ffhb_saison
  UNIQUE (id_ffhb, saison_code);

CREATE INDEX IF NOT EXISTS idx_equipes_club          ON core.equipes (club_id);
CREATE INDEX IF NOT EXISTS idx_equipes_ext_structure ON core.equipes (ext_structure_id);
CREATE INDEX IF NOT EXISTS idx_equipes_nom_trgm      ON core.equipes USING gin (nom gin_trgm_ops);
```

⚠️ `core.engagements` n'est PAS modifiée — sa structure `(equipe_id FK, poule_id FK, PK composite)` est déjà correcte.

- [ ] **Step 2.3 : Lancer + vérifier**

```bash
npm run db:migrate
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.equipes"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt raw.engagements"
```

Confirmer :
- `core.equipes` a `club_id` nullable, `nom` (pas `nom_equipe`), `sexe` nullable, `categorie_age` nullable, nouvelles colonnes `id_ffhb`/`ext_structure_id`/`logo`
- UNIQUE `(id_ffhb, saison_code)` présente
- 3 indexes présents (club, ext_structure, nom_trgm)
- `raw.engagements` existe avec colonnes standard (natural_key, payload, saison, http_status, etc.)

- [ ] **Step 2.4 : Commit**

```bash
git add db/migrations/0009_equipes_engagements.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 0009 — equipes + engagements

T2 : raw.engagements + alter core.equipes (nullable club_id/sexe/
categorie_age, rename nom_equipe→nom, ajout id_ffhb/ext_structure_id/
logo, nouvelle UNIQUE (id_ffhb, saison_code)).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Étendre parseCompetitionDetail — cas calendar-button

**Files:**
- Modify: `src/scrapers/ffhandball/competition-detail.scraper.ts`
- Modify: `tests/scrapers/competition-detail.scraper.test.ts`

- [ ] **Step 3.1 : Ajouter les tests calendar-button (failing)**

Ajouter à la fin de `tests/scrapers/competition-detail.scraper.test.ts` (après les 5 tests existants) :

```ts
describe("parseCompetitionDetail — équipes via calendar-button", () => {
  it("extracts 14 équipes + 14 engagements from mono-poule LBE", () => {
    const html = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(html, SOURCE_URL_MONO, "28227");
    expect(r).not.toBeNull();
    expect(r!.equipes.length).toBe(14);
    expect(r!.engagements.length).toBe(14);

    // Chaque équipe a ext_structure_id et logo (via calendar-button)
    expect(r!.equipes.every((e) => e.ext_structure_id !== undefined)).toBe(true);
    expect(r!.equipes.every((e) => e.logo !== undefined)).toBe(true);

    // Tous les engagements pointent vers la même poule (mono-poule)
    const pouleIds = new Set(r!.engagements.map((en) => en.ext_poule_id));
    expect(pouleIds.size).toBe(1);
  });

  it("extracts 96 équipes + 96 engagements from multi-poules N3M, mapped to 8 distinct poules", () => {
    const html = fixture("ffhandball-competition-detail-multi-poules.html");
    const r = parseCompetitionDetail(html, "https://x/", "9999");
    expect(r).not.toBeNull();
    expect(r!.equipes.length).toBe(96);
    expect(r!.engagements.length).toBe(96);

    const pouleIds = new Set(r!.engagements.map((en) => en.ext_poule_id));
    expect(pouleIds.size).toBe(8);

    // Chaque ext_poule_id présent dans engagements doit exister dans poules
    const knownPouleIds = new Set(r!.poules.map((p) => p.ext_poule_id));
    for (const pid of pouleIds) {
      expect(knownPouleIds.has(pid)).toBe(true);
    }
  });

  it("deduplicates équipes by ext_equipe_id (same team in multiple appearances)", () => {
    const html = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(html, SOURCE_URL_MONO, "28227");
    const ids = r!.equipes.map((e) => e.ext_equipe_id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});
```

- [ ] **Step 3.2 : Run failing**

```bash
npx vitest run tests/scrapers/competition-detail.scraper.test.ts
```

Expected: 3 nouveaux tests FAIL (l'implémentation actuelle ne retourne pas `equipes`/`engagements`). Les 5 tests existants restent FAIL aussi car le `CompetitionDetailResult` ne contient pas encore les nouveaux champs.

- [ ] **Step 3.3 : Étendre l'implémentation**

Remplacer le contenu de `src/scrapers/ffhandball/competition-detail.scraper.ts` :

```ts
import * as cheerio from "cheerio";
import { rawPhasePayloadSchema, type RawPhasePayload } from "@/schemas/phase.schema.js";
import { rawPoulePayloadSchema, type RawPoulePayload } from "@/schemas/poule.schema.js";
import { rawEquipePayloadSchema, type RawEquipePayload } from "@/schemas/equipe.schema.js";
import { rawEngagementPayloadSchema, type RawEngagementPayload } from "@/schemas/engagement.schema.js";

export interface CompetitionDetailResult {
  phases: RawPhasePayload[];
  poules: RawPoulePayload[];
  equipes: RawEquipePayload[];
  engagements: RawEngagementPayload[];
}

interface SourceTeam {
  id?: unknown;
  ext_equipeId?: unknown;
  pouleId?: unknown;
  structureId?: unknown;
  ext_structureId?: unknown;
  libelle?: unknown;
  logo?: unknown;
  logoActif?: unknown;
}

function loadAttributes($: cheerio.CheerioAPI, componentName: string): unknown | null {
  const el = $(`smartfire-component[name='${componentName}']`).first();
  const raw = el.attr("attributes");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseCompetitionDetail(
  html: string,
  sourceUrl: string,
  extCompetitionId: string,
): CompetitionDetailResult | null {
  const $ = cheerio.load(html);

  // 1. poule-selector → phases + poules + index (pouleId interne → ext_poule_id)
  const pouleSelectorData = loadAttributes($, "competitions---poule-selector");
  if (!pouleSelectorData) return null;

  const root = pouleSelectorData as {
    phases?: unknown;
    poules?: unknown;
    equipe_options?: unknown;
  };

  const rawPhases = Array.isArray(root.phases) ? root.phases : [];
  const rawPoules = Array.isArray(root.poules) ? root.poules : [];

  // Build id → ext_phaseId mapping (existing)
  const phaseIdIndex = new Map<string, string>();
  const phases: RawPhasePayload[] = [];
  for (const ph of rawPhases) {
    const item = ph as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : null;
    const extPhaseId = typeof item.ext_phaseId === "string" ? item.ext_phaseId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!id || !extPhaseId || !libelle) continue;
    phaseIdIndex.set(id, extPhaseId);

    const parsed = rawPhasePayloadSchema.safeParse({
      ext_phase_id: extPhaseId,
      ext_competition_id: extCompetitionId,
      nom: libelle,
      source_url: sourceUrl,
    });
    if (parsed.success) phases.push(parsed.data);
  }

  // Build internal pouleId → ext_poule_id mapping
  const pouleIdIndex = new Map<string, string>();
  const poules: RawPoulePayload[] = [];
  for (const po of rawPoules) {
    const item = po as Record<string, unknown>;
    const internalPouleId = typeof item.id === "string" ? item.id : null;
    const extPouleId = typeof item.ext_pouleId === "string" ? item.ext_pouleId : null;
    const internalPhaseId = typeof item.phaseId === "string" ? item.phaseId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!internalPouleId || !extPouleId || !internalPhaseId || !libelle) continue;

    pouleIdIndex.set(internalPouleId, extPouleId);

    const extPhaseId = phaseIdIndex.get(internalPhaseId);
    if (!extPhaseId) continue;

    const parsed = rawPoulePayloadSchema.safeParse({
      ext_poule_id: extPouleId,
      ext_phase_id: extPhaseId,
      nom: libelle,
      source_url: sourceUrl,
    });
    if (parsed.success) poules.push(parsed.data);
  }

  // 2. NOUVEAU : équipes + engagements depuis calendar-button (avec fallback equipe_options)
  const calendarData = loadAttributes($, "competitions---calendar-button") as
    | { equipes?: unknown }
    | null;

  let rawTeams: SourceTeam[] = [];
  if (calendarData && Array.isArray(calendarData.equipes) && calendarData.equipes.length > 0) {
    rawTeams = calendarData.equipes as SourceTeam[];
  } else if (Array.isArray(root.equipe_options) && root.equipe_options.length > 0) {
    rawTeams = root.equipe_options as SourceTeam[];
  }

  const equipes: RawEquipePayload[] = [];
  const engagements: RawEngagementPayload[] = [];
  const seenEquipeIds = new Set<string>();
  const seenEngagements = new Set<string>();

  for (const t of rawTeams) {
    const extEquipeId = typeof t.ext_equipeId === "string" ? t.ext_equipeId : null;
    const nom = typeof t.libelle === "string" ? t.libelle.trim() : null;
    const internalPouleId = typeof t.pouleId === "string" ? t.pouleId : null;
    if (!extEquipeId || !nom || !internalPouleId) continue;

    const extPouleId = pouleIdIndex.get(internalPouleId);
    if (!extPouleId) continue; // orpheline

    if (!seenEquipeIds.has(extEquipeId)) {
      seenEquipeIds.add(extEquipeId);
      const parsedEq = rawEquipePayloadSchema.safeParse({
        ext_equipe_id: extEquipeId,
        nom,
        ext_structure_id: typeof t.ext_structureId === "string" ? t.ext_structureId : undefined,
        logo: typeof t.logo === "string" ? t.logo : undefined,
        source_url: sourceUrl,
      });
      if (parsedEq.success) equipes.push(parsedEq.data);
    }

    const engKey = `${extEquipeId}-${extPouleId}`;
    if (!seenEngagements.has(engKey)) {
      seenEngagements.add(engKey);
      const parsedEn = rawEngagementPayloadSchema.safeParse({
        ext_equipe_id: extEquipeId,
        ext_poule_id: extPouleId,
        source_url: sourceUrl,
      });
      if (parsedEn.success) engagements.push(parsedEn.data);
    }
  }

  return { phases, poules, equipes, engagements };
}
```

- [ ] **Step 3.4 : Run tests passing**

```bash
npx vitest run tests/scrapers/competition-detail.scraper.test.ts
```

Expected: 5 tests existants + 3 nouveaux = **8 passed**.

⚠️ Si les tests existants échouent à cause de la signature changée (`CompetitionDetailResult` a 2 nouveaux champs), ils ne devraient PAS échouer car ces tests n'accèdent qu'aux champs `phases` et `poules`. Si néanmoins ils échouent, vérifier le mock TypeScript / la déstructuration dans les tests.

- [ ] **Step 3.5 : Commit**

```bash
git add src/scrapers/ffhandball/competition-detail.scraper.ts tests/scrapers/competition-detail.scraper.test.ts
git commit -m "$(cat <<'EOF'
feat: parseCompetitionDetail extrait équipes + engagements

T3 : extension du scraper pour parser calendar-button (toutes les
équipes de toutes les poules de la compétition). Construit l'index
pouleId interne → ext_poule_id pour résoudre les engagements.
Dédoublonne par ext_equipe_id et (ext_equipe_id, ext_poule_id).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Tests fallback equipe_options

**Files:**
- Modify: `tests/scrapers/competition-detail.scraper.test.ts`

- [ ] **Step 4.1 : Ajouter les tests de fallback**

Ajouter à la fin du fichier :

```ts
describe("parseCompetitionDetail — fallback equipe_options", () => {
  it("falls back to equipe_options when calendar-button is absent", () => {
    // HTML synthétique : poule-selector complet avec equipe_options, PAS de calendar-button
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        phases: [{ id: "P1", ext_phaseId: "EP1", libelle: "phase A" }],
        poules: [
          { id: "PO1", ext_pouleId: "EPO1", phaseId: "P1", libelle: "Poule 1" },
        ],
        equipe_options: [
          {
            id: "1",
            ext_equipeId: "EQ1",
            pouleId: "PO1",
            structureId: "532",
            libelle: "CLUB A",
            logoActif: "1",
          },
          {
            id: "2",
            ext_equipeId: "EQ2",
            pouleId: "PO1",
            structureId: "533",
            libelle: "CLUB B",
            logoActif: "1",
          },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;

    const r = parseCompetitionDetail(html, "https://x/", "C1");
    expect(r).not.toBeNull();
    expect(r!.equipes.length).toBe(2);
    expect(r!.engagements.length).toBe(2);
    // Champs manquants dans le fallback : ext_structure_id et logo
    expect(r!.equipes.every((e) => e.ext_structure_id === undefined)).toBe(true);
    expect(r!.equipes.every((e) => e.logo === undefined)).toBe(true);
  });

  it("returns empty equipes/engagements when both calendar-button and equipe_options are absent", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        phases: [{ id: "P1", ext_phaseId: "EP1", libelle: "phase" }],
        poules: [
          { id: "PO1", ext_pouleId: "EPO1", phaseId: "P1", libelle: "Poule" },
        ],
        // no equipe_options
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;

    const r = parseCompetitionDetail(html, "https://x/", "C1");
    expect(r).not.toBeNull();
    expect(r!.equipes).toEqual([]);
    expect(r!.engagements).toEqual([]);
    // phases/poules toujours présents
    expect(r!.phases.length).toBe(1);
    expect(r!.poules.length).toBe(1);
  });

  it("skips équipes whose pouleId is orphan (not in poules[])", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        phases: [{ id: "P1", ext_phaseId: "EP1", libelle: "phase" }],
        poules: [
          { id: "PO1", ext_pouleId: "EPO1", phaseId: "P1", libelle: "Poule" },
        ],
        equipe_options: [
          { id: "1", ext_equipeId: "EQ_OK", pouleId: "PO1", libelle: "ok" },
          { id: "2", ext_equipeId: "EQ_ORPH", pouleId: "GHOST_POULE", libelle: "orphan" },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;

    const r = parseCompetitionDetail(html, "https://x/", "C1");
    expect(r).not.toBeNull();
    expect(r!.equipes.length).toBe(1);
    expect(r!.equipes[0]!.ext_equipe_id).toBe("EQ_OK");
    expect(r!.engagements.length).toBe(1);
  });
});
```

- [ ] **Step 4.2 : Run tests passing**

```bash
npx vitest run tests/scrapers/competition-detail.scraper.test.ts
```

Expected: 8 précédents + 3 nouveaux = **11 passed**.

- [ ] **Step 4.3 : Commit**

```bash
git add tests/scrapers/competition-detail.scraper.test.ts
git commit -m "$(cat <<'EOF'
test: fallback equipe_options + équipes orphelines

T4 : couverture du cas calendar-button absent (fallback sur poule-
selector.equipe_options, sans ext_structure_id/logo) + cas équipes
sans poule connue (skip silencieux).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLI scrape — insertion raw.equipes + raw.engagements

**Files:**
- Modify: `src/cli/scrape.ts`

- [ ] **Step 5.1 : Étendre le handler `scrapeCompetitions`**

Localiser dans `src/cli/scrape.ts` la boucle "passe B" du handler `scrapeCompetitions`, après l'insertion des poules. Ajouter l'insertion des équipes et engagements :

```ts
      // Existing : insertion phases + poules
      for (const ph of parsed.phases) { /* ... */ }
      for (const po of parsed.poules) { /* ... */ }

      // NOUVEAU : insertion équipes + engagements
      for (const eq of parsed.equipes) {
        await insertRaw("equipes", {
          scrape_run_id: run.id,
          source_url: eq.source_url,
          source_site: "ffhandball.fr",
          natural_key: eq.ext_equipe_id,
          payload: eq,
          saison,
          http_status: res.status,
        });
        insertedEquipes++;
      }
      for (const en of parsed.engagements) {
        await insertRaw("engagements", {
          scrape_run_id: run.id,
          source_url: en.source_url,
          source_site: "ffhandball.fr",
          natural_key: `${en.ext_equipe_id}-${en.ext_poule_id}`,
          payload: en,
          saison,
          http_status: res.status,
        });
        insertedEngagements++;
      }
```

Ajouter les compteurs en début de fonction (à côté de `insertedPhases` et `insertedPoules`) :

```ts
    let insertedPhases = 0;
    let insertedPoules = 0;
    let insertedEquipes = 0;       // ← nouveau
    let insertedEngagements = 0;   // ← nouveau
    let parseFailed = 0;
```

Et étendre le `logger.info` final :

```ts
    logger.info(
      { totalCompetitions, insertedPhases, insertedPoules, insertedEquipes, insertedEngagements, parseFailed },
      "competitions scrape done",
    );
```

- [ ] **Step 5.2 : Smoke test localement**

Réutiliser l'infrastructure de pages déjà fetchées une fois :

```bash
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=2
```

Vérifier :

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'competitions' AS t, count(*) FROM raw.competitions
   UNION ALL SELECT 'phases', count(*) FROM raw.phases
   UNION ALL SELECT 'poules', count(*) FROM raw.poules
   UNION ALL SELECT 'equipes', count(*) FROM raw.equipes
   UNION ALL SELECT 'engagements', count(*) FROM raw.engagements;"
```

Expected : ≥1 ligne dans `raw.equipes` et `raw.engagements` (la LBE a 14 équipes par compétition mono-poule).

- [ ] **Step 5.3 : Commit**

```bash
git add src/cli/scrape.ts
git commit -m "$(cat <<'EOF'
feat(cli): scrape competitions insère équipes + engagements

T5 : extension du handler scrapeCompetitions pour insérer dans
raw.equipes et raw.engagements à partir de parsed.equipes /
parsed.engagements. natural_key engagement = ext_equipe_id-ext_poule_id.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: ETL equipes (club_id = NULL + warning)

**Files:**
- Create: `src/etl/equipes.etl.ts`
- Create: `tests/etl/equipes.etl.test.ts`

- [ ] **Step 6.1 : Tests (failing)**

```ts
// tests/etl/equipes.etl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runEquipesEtl } from "@/etl/equipes.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function insertRawEquipe(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.equipes (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runEquipesEtl", () => {
  beforeEach(async () => {
    // Cleanup respecting FKs
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await query(`TRUNCATE core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts equipe with club_id NULL + warning", async () => {
    await insertRawEquipe(
      {
        ext_equipe_id: "EQ1",
        nom: "BREST BRETAGNE HANDBALL",
        ext_structure_id: "1720",
        logo: "logo.jpg",
        source_url: "https://x/",
      },
      "EQ1",
    );
    const report = await runEquipesEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(1);

    const row = await query<{
      nom: string;
      club_id: number | null;
      ext_structure_id: string | null;
      logo: string | null;
    }>(`SELECT nom, club_id, ext_structure_id, logo FROM core.equipes WHERE id_ffhb = 'EQ1'`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.club_id).toBeNull();
    expect(row.rows[0]!.ext_structure_id).toBe("1720");
    expect(row.rows[0]!.logo).toBe("logo.jpg");
  });

  it("rejects invalid payload", async () => {
    await insertRawEquipe({ junk: true } as object, "BAD");
    const report = await runEquipesEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run → 1 ligne, 2 warnings total over 2 runs)", async () => {
    await insertRawEquipe(
      { ext_equipe_id: "EQ1", nom: "X", source_url: "https://x/" },
      "EQ1",
    );
    await runEquipesEtl(SAISON);
    await runEquipesEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.equipes`);
    expect(Number(r.rows[0]!.count)).toBe(1);
    const w = await query<{ count: string }>(`SELECT count(*) FROM core.etl_warnings WHERE entity='equipes'`);
    expect(Number(w.rows[0]!.count)).toBe(2);
  });

  it("updates equipe when nom or logo changes (updated_at bumps)", async () => {
    await insertRawEquipe(
      { ext_equipe_id: "EQ1", nom: "Old name", logo: "old.jpg", source_url: "https://x/" },
      "EQ1",
    );
    await runEquipesEtl(SAISON);
    const before = await query<{ updated_at: Date }>(`SELECT updated_at FROM core.equipes WHERE id_ffhb='EQ1'`);

    // Sleep a tiny bit to ensure clock difference
    await new Promise((r) => setTimeout(r, 50));

    await insertRawEquipe(
      { ext_equipe_id: "EQ1", nom: "New name", logo: "new.jpg", source_url: "https://x/" },
      "EQ1",
    );
    await runEquipesEtl(SAISON);
    const after = await query<{ updated_at: Date; nom: string; logo: string | null }>(
      `SELECT updated_at, nom, logo FROM core.equipes WHERE id_ffhb='EQ1'`,
    );
    expect(after.rows[0]!.nom).toBe("New name");
    expect(after.rows[0]!.logo).toBe("new.jpg");
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.rows[0]!.updated_at.getTime());
  });
});
```

- [ ] **Step 6.2 : Run failing**

```bash
npx vitest run tests/etl/equipes.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 6.3 : Implémenter `equipes.etl.ts`**

```ts
// src/etl/equipes.etl.ts
import { query } from "@/db/client.js";
import { rawEquipePayloadSchema, type RawEquipePayload } from "@/schemas/equipe.schema.js";
import { logger } from "@/lib/logger.js";

interface RawEquipeRow {
  id: number;
  natural_key: string;
  payload: unknown;
}

export interface EtlReport {
  etl_run_id: number;
  rows_read: number;
  rows_validated: number;
  rows_rejected: number;
  rows_inserted: number;
  rows_updated: number;
  rows_noop: number;
  warnings_count: number;
}

export async function runEquipesEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('equipes', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report: EtlReport = {
    etl_run_id,
    rows_read: 0,
    rows_validated: 0,
    rows_rejected: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_noop: 0,
    warnings_count: 0,
  };

  try {
    const rawRows = await query<RawEquipeRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.equipes
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawEquipePayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'equipes',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawEquipePayload = parsed.data;

      // club_id reste NULL pour cette feature (résolution différée)
      await query(
        `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
         VALUES ($1, 'equipes', $2, $3)`,
        [
          etl_run_id,
          p.ext_equipe_id,
          `club_id non résolu (ext_structure_id=${p.ext_structure_id ?? "absent"})`,
        ],
      );
      report.warnings_count++;

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.equipes (id_ffhb, nom, ext_structure_id, logo, saison_code, last_seen_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id_ffhb, saison_code) DO UPDATE
         SET nom = EXCLUDED.nom,
             ext_structure_id = COALESCE(EXCLUDED.ext_structure_id, core.equipes.ext_structure_id),
             logo = COALESCE(EXCLUDED.logo, core.equipes.logo),
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.equipes.nom IS DISTINCT FROM EXCLUDED.nom
                 OR (EXCLUDED.ext_structure_id IS NOT NULL
                     AND core.equipes.ext_structure_id IS DISTINCT FROM EXCLUDED.ext_structure_id)
                 OR (EXCLUDED.logo IS NOT NULL
                     AND core.equipes.logo IS DISTINCT FROM EXCLUDED.logo)
               THEN now()
               ELSE core.equipes.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.ext_equipe_id, p.nom, p.ext_structure_id ?? null, p.logo ?? null, saison],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'success',
             rows_read=$2, rows_validated=$3, rows_rejected=$4,
             rows_inserted=$5, rows_updated=$6, rows_noop=$7, warnings_count=$8
         WHERE id = $1`,
      [
        etl_run_id,
        report.rows_read,
        report.rows_validated,
        report.rows_rejected,
        report.rows_inserted,
        report.rows_updated,
        report.rows_noop,
        report.warnings_count,
      ],
    );

    logger.info(report, "equipes ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
```

- [ ] **Step 6.4 : Run tests passing**

```bash
npx vitest run tests/etl/equipes.etl.test.ts
```

Expected: 4 passed.

- [ ] **Step 6.5 : Commit**

```bash
git add src/etl/equipes.etl.ts tests/etl/equipes.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL equipes (club_id NULL + warning)

T6 : raw.equipes → core.equipes. club_id reste NULL pour l'instant
(résolution différée à une future feature). Un warning ETL est émis
par équipe à chaque run pour traçabilité.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: ETL engagements (FK equipe + FK poule)

**Files:**
- Create: `src/etl/engagements.etl.ts`
- Create: `tests/etl/engagements.etl.test.ts`

- [ ] **Step 7.1 : Tests (failing)**

```ts
// tests/etl/engagements.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runEngagementsEtl } from "@/etl/engagements.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extPouleId: string, extEquipeId: string): Promise<{ equipe_id: number; poule_id: number }> {
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1','C','national',$1)
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const phase = await query<{ id: number }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ('PH1', $1, 'P', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const poule = await query<{ id: number }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
     VALUES ($1, $2, 'Poule', $3)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [extPouleId, phase.rows[0]!.id, SAISON],
  );
  const equipe = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ($1, 'Equipe', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [extEquipeId, SAISON],
  );
  return { equipe_id: equipe.rows[0]!.id, poule_id: poule.rows[0]!.id };
}

async function insertRawEngagement(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.engagements (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runEngagementsEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.engagements`);
    await query(`DELETE FROM raw.equipes`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await query(`TRUNCATE core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts engagement when both FKs resolve", async () => {
    const { equipe_id, poule_id } = await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "EQ1", ext_poule_id: "EPO1", source_url: "https://x/" },
      "EQ1-EPO1",
    );
    const report = await runEngagementsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);
    const row = await query<{ equipe_id: number; poule_id: number }>(
      `SELECT equipe_id, poule_id FROM core.engagements`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.equipe_id).toBe(equipe_id);
    expect(row.rows[0]!.poule_id).toBe(poule_id);
  });

  it("warns and skips when equipe FK does not resolve", async () => {
    await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "GHOST", ext_poule_id: "EPO1", source_url: "https://x/" },
      "GHOST-EPO1",
    );
    const report = await runEngagementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips when poule FK does not resolve", async () => {
    await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "EQ1", ext_poule_id: "GHOST", source_url: "https://x/" },
      "EQ1-GHOST",
    );
    const report = await runEngagementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("is idempotent via ON CONFLICT on composite PK", async () => {
    await seedHierarchy("EPO1", "EQ1");
    await insertRawEngagement(
      { ext_equipe_id: "EQ1", ext_poule_id: "EPO1", source_url: "https://x/" },
      "EQ1-EPO1",
    );
    await runEngagementsEtl(SAISON);
    await runEngagementsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.engagements`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  afterAll(async () => {
    await closePool();
  });
});
```

⚠️ Le `afterAll(closePool)` est ici car ce sera le dernier fichier ETL du suite après T7. Le fichier `tests/etl/poules.etl.test.ts` doit conserver son `afterAll(closePool)` (vitest isole les pools par fichier — voir T12 de la feature précédente).

- [ ] **Step 7.2 : Run failing**

```bash
npx vitest run tests/etl/engagements.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 7.3 : Implémenter `engagements.etl.ts`**

```ts
// src/etl/engagements.etl.ts
import { query } from "@/db/client.js";
import { rawEngagementPayloadSchema, type RawEngagementPayload } from "@/schemas/engagement.schema.js";
import { logger } from "@/lib/logger.js";

interface RawEngagementRow {
  id: number;
  natural_key: string;
  payload: unknown;
}

export interface EtlReport {
  etl_run_id: number;
  rows_read: number;
  rows_validated: number;
  rows_rejected: number;
  rows_inserted: number;
  rows_updated: number;
  rows_noop: number;
  warnings_count: number;
}

async function resolveEquipeId(idFfhb: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.equipes WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

async function resolvePouleId(idFfhb: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.poules WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

export async function runEngagementsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('engagements', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report: EtlReport = {
    etl_run_id,
    rows_read: 0,
    rows_validated: 0,
    rows_rejected: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_noop: 0,
    warnings_count: 0,
  };

  try {
    const rawRows = await query<RawEngagementRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.engagements
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawEngagementPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'engagements',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawEngagementPayload = parsed.data;
      const equipe_id = await resolveEquipeId(p.ext_equipe_id, saison);
      if (equipe_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'engagements',$2,$3)`,
          [etl_run_id, row.natural_key, `equipe ${p.ext_equipe_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }
      const poule_id = await resolvePouleId(p.ext_poule_id, saison);
      if (poule_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'engagements',$2,$3)`,
          [etl_run_id, row.natural_key, `poule ${p.ext_poule_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const upsert = await query<{ inserted: boolean }>(
        `INSERT INTO core.engagements (equipe_id, poule_id)
         VALUES ($1, $2)
         ON CONFLICT (equipe_id, poule_id) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        [equipe_id, poule_id],
      );

      if (upsert.rowCount && upsert.rowCount > 0 && upsert.rows[0]!.inserted) {
        report.rows_inserted++;
      } else {
        report.rows_noop++;
      }
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'success',
             rows_read=$2, rows_validated=$3, rows_rejected=$4,
             rows_inserted=$5, rows_updated=$6, rows_noop=$7, warnings_count=$8
         WHERE id = $1`,
      [
        etl_run_id,
        report.rows_read,
        report.rows_validated,
        report.rows_rejected,
        report.rows_inserted,
        report.rows_updated,
        report.rows_noop,
        report.warnings_count,
      ],
    );

    logger.info(report, "engagements ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
```

- [ ] **Step 7.4 : Run tests passing**

```bash
npx vitest run tests/etl/engagements.etl.test.ts
```

Expected: 4 passed.

- [ ] **Step 7.5 : Commit**

```bash
git add src/etl/engagements.etl.ts tests/etl/engagements.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL engagements (FK equipe + FK poule)

T7 : raw.engagements → core.engagements. Résolution FK équipe via
core.equipes.id_ffhb + FK poule via core.poules.id_ffhb. Warning +
skip si l'une des deux ne résout pas. Idempotent via ON CONFLICT
DO NOTHING sur PK composite.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: CLI etl dispatch equipes + engagements

**Files:**
- Modify: `src/cli/etl.ts`

- [ ] **Step 8.1 : Ajouter 2 imports + 2 branches**

Ajouter imports en tête :

```ts
import { runEquipesEtl } from "@/etl/equipes.etl.js";
import { runEngagementsEtl } from "@/etl/engagements.etl.js";
```

Dans `main()`, après les dispatchs `competitions/phases/poules` existants :

```ts
  } else if (args.entity === "equipes") {
    await runEquipesEtl(args.saison);
  } else if (args.entity === "engagements") {
    await runEngagementsEtl(args.saison);
```

- [ ] **Step 8.2 : Tester en exécutant la chaîne complète**

Lancer les 5 ETL dans l'ordre (avec données du smoke test T5 dans raw) :

```bash
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
npm run etl -- --entity=equipes      --saison=2025-2026
npm run etl -- --entity=engagements  --saison=2025-2026
```

Vérifier :

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'competitions' AS t, count(*) FROM core.competitions
   UNION ALL SELECT 'phases', count(*) FROM core.phases
   UNION ALL SELECT 'poules', count(*) FROM core.poules
   UNION ALL SELECT 'equipes', count(*) FROM core.equipes
   UNION ALL SELECT 'engagements', count(*) FROM core.engagements
   UNION ALL SELECT 'warnings_equipes', count(*) FROM core.etl_warnings WHERE entity='equipes'
   UNION ALL SELECT 'warnings_engagements', count(*) FROM core.etl_warnings WHERE entity='engagements';"
```

Expected : counts > 0 dans toutes les entités, ~14+ équipes/engagements (selon le smoke test T5 avec --limit=2), warnings_equipes = nb_equipes (un par équipe, club_id NULL), warnings_engagements = 0 si FKs OK.

- [ ] **Step 8.3 : Commit**

```bash
git add src/cli/etl.ts
git commit -m "$(cat <<'EOF'
feat(cli): etl --entity=equipes|engagements

T8 : dispatch des 2 nouveaux ETL. Ordre complet du pipeline :
competitions → phases → poules → equipes → engagements.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Test intégration end-to-end

**Files:**
- Create: `tests/integration/equipes-end-to-end.test.ts`

- [ ] **Step 9.1 : Écrire le test (failing)**

```ts
// tests/integration/equipes-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseCompetitionList } from "@/scrapers/ffhandball/competition-list.scraper.js";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";
import { runEquipesEtl } from "@/etl/equipes.etl.js";
import { runEngagementsEtl } from "@/etl/engagements.etl.js";

const SAISON = "2025-2026";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

async function setup(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("equipes + engagements end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.engagements; DELETE FROM raw.equipes; DELETE FROM raw.poules; DELETE FROM raw.phases; DELETE FROM raw.competitions;`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await query(`TRUNCATE core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();
  });

  it("scrapes mono-poule LBE → 5 ETLs in order → core populated", async () => {
    const run_id = await startRun();

    // 1. Parse + insertRaw competitions
    const compHtml = fixture("ffhandball-competitions-national.html");
    const sourceUrl = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/";
    const comps = parseCompetitionList(compHtml, "national", sourceUrl, "2025-2026", "21");
    const lbe = comps.find((c) => c.ext_competition_id === "28227");
    expect(lbe).toBeDefined();
    await insertRaw("competitions", {
      scrape_run_id: run_id,
      source_url: lbe!.source_url,
      source_site: "ffhandball.fr",
      natural_key: lbe!.ext_competition_id,
      payload: lbe!,
      saison: SAISON,
      http_status: 200,
    });

    // 2. Parse fixture détail (LBE — 14 équipes, 1 phase, 1 poule)
    const detailHtml = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(detailHtml, lbe!.detail_url, lbe!.ext_competition_id);
    expect(r).not.toBeNull();
    expect(r!.equipes.length).toBe(14);
    expect(r!.engagements.length).toBe(14);

    for (const ph of r!.phases) {
      await insertRaw("phases", { scrape_run_id: run_id, source_url: ph.source_url, source_site: "ffhandball.fr", natural_key: ph.ext_phase_id, payload: ph, saison: SAISON, http_status: 200 });
    }
    for (const po of r!.poules) {
      await insertRaw("poules", { scrape_run_id: run_id, source_url: po.source_url, source_site: "ffhandball.fr", natural_key: po.ext_poule_id, payload: po, saison: SAISON, http_status: 200 });
    }
    for (const eq of r!.equipes) {
      await insertRaw("equipes", { scrape_run_id: run_id, source_url: eq.source_url, source_site: "ffhandball.fr", natural_key: eq.ext_equipe_id, payload: eq, saison: SAISON, http_status: 200 });
    }
    for (const en of r!.engagements) {
      await insertRaw("engagements", { scrape_run_id: run_id, source_url: en.source_url, source_site: "ffhandball.fr", natural_key: `${en.ext_equipe_id}-${en.ext_poule_id}`, payload: en, saison: SAISON, http_status: 200 });
    }

    // 3. Run 5 ETLs in order
    const c1 = await runCompetitionsEtl(SAISON);
    expect(c1.rows_inserted).toBe(1);
    const p1 = await runPhasesEtl(SAISON);
    expect(p1.rows_inserted).toBe(1);
    expect(p1.warnings_count).toBe(0);
    const po1 = await runPoulesEtl(SAISON);
    expect(po1.rows_inserted).toBe(1);
    expect(po1.warnings_count).toBe(0);
    const eq1 = await runEquipesEtl(SAISON);
    expect(eq1.rows_inserted).toBe(14);
    expect(eq1.warnings_count).toBe(14); // un par équipe (club_id NULL)
    const en1 = await runEngagementsEtl(SAISON);
    expect(en1.rows_inserted).toBe(14);
    expect(en1.warnings_count).toBe(0); // FKs résolues

    // 4. Vérifications finales
    const counts = await query<{ t: string; c: string }>(
      `SELECT 'equipes' AS t, count(*)::text AS c FROM core.equipes
       UNION ALL SELECT 'engagements', count(*)::text FROM core.engagements`,
    );
    const map = new Map(counts.rows.map((row) => [row.t, Number(row.c)]));
    expect(map.get("equipes")).toBe(14);
    expect(map.get("engagements")).toBe(14);

    // Toutes les équipes ont club_id NULL
    const nullCount = await query<{ count: string }>(
      `SELECT count(*) FROM core.equipes WHERE club_id IS NULL`,
    );
    expect(Number(nullCount.rows[0]!.count)).toBe(14);
  });

  it("is idempotent end-to-end (re-run ETLs = same counts)", async () => {
    const run_id = await startRun();
    const compHtml = fixture("ffhandball-competitions-national.html");
    const comps = parseCompetitionList(compHtml, "national", "https://x/", "2025-2026", "21");
    const lbe = comps.find((c) => c.ext_competition_id === "28227")!;
    await insertRaw("competitions", { scrape_run_id: run_id, source_url: lbe.source_url, source_site: "ffhandball.fr", natural_key: lbe.ext_competition_id, payload: lbe, saison: SAISON, http_status: 200 });
    const detailHtml = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(detailHtml, lbe.detail_url, lbe.ext_competition_id)!;
    for (const ph of r.phases) await insertRaw("phases", { scrape_run_id: run_id, source_url: ph.source_url, source_site: "ffhandball.fr", natural_key: ph.ext_phase_id, payload: ph, saison: SAISON, http_status: 200 });
    for (const po of r.poules) await insertRaw("poules", { scrape_run_id: run_id, source_url: po.source_url, source_site: "ffhandball.fr", natural_key: po.ext_poule_id, payload: po, saison: SAISON, http_status: 200 });
    for (const eq of r.equipes) await insertRaw("equipes", { scrape_run_id: run_id, source_url: eq.source_url, source_site: "ffhandball.fr", natural_key: eq.ext_equipe_id, payload: eq, saison: SAISON, http_status: 200 });
    for (const en of r.engagements) await insertRaw("engagements", { scrape_run_id: run_id, source_url: en.source_url, source_site: "ffhandball.fr", natural_key: `${en.ext_equipe_id}-${en.ext_poule_id}`, payload: en, saison: SAISON, http_status: 200 });

    await runCompetitionsEtl(SAISON);
    await runPhasesEtl(SAISON);
    await runPoulesEtl(SAISON);
    await runEquipesEtl(SAISON);
    await runEngagementsEtl(SAISON);

    const before_eq = (await query<{ count: string }>(`SELECT count(*) FROM core.equipes`)).rows[0]!.count;
    const before_en = (await query<{ count: string }>(`SELECT count(*) FROM core.engagements`)).rows[0]!.count;

    await runEquipesEtl(SAISON);
    await runEngagementsEtl(SAISON);

    const after_eq = (await query<{ count: string }>(`SELECT count(*) FROM core.equipes`)).rows[0]!.count;
    const after_en = (await query<{ count: string }>(`SELECT count(*) FROM core.engagements`)).rows[0]!.count;
    expect(after_eq).toBe(before_eq);
    expect(after_en).toBe(before_en);
  });
});
```

⚠️ Ne PAS ajouter `afterAll(closePool)` ici — c'est déjà dans `tests/etl/engagements.etl.test.ts` (T7) qui est le dernier fichier ETL exécuté.

- [ ] **Step 9.2 : Run tests passing**

```bash
npx vitest run tests/integration/equipes-end-to-end.test.ts
```

Expected: 2 passed.

- [ ] **Step 9.3 : Run la suite complète en mode séquentiel**

```bash
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
```

Expected : 81 tests existants + 17 nouveaux (T1: 7, T3: 3, T4: 3, T6: 4, T7: 4, T9: 2) ≈ ~98 tests pass.

Note : les 14 warnings émis par `runEquipesEtl` sur 14 équipes sont attendus (un par équipe, club_id NULL). C'est cohérent avec la design decision "résolution différée".

- [ ] **Step 9.4 : Commit**

```bash
git add tests/integration/equipes-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test: intégration end-to-end equipes + engagements

T9 : scrape (fixtures) → 5 ETLs en séquence → vérification counts +
club_id NULL. Idempotence du re-run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Runbook + smoke test full pipeline

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 10.1 : Ajouter la sous-section équipes/engagements**

Ajouter dans `docs/runbook.md`, à la fin de la section "## Scraper les compétitions" existante (juste avant la section suivante ou en fin de fichier si c'est la dernière) :

```markdown
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
```

- [ ] **Step 10.2 : Smoke test final — full pipeline**

Validation finale sur un échantillon réel :

```bash
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=3
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
npm run etl -- --entity=equipes      --saison=2025-2026
npm run etl -- --entity=engagements  --saison=2025-2026
```

Vérifier :

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'competitions' AS t, count(*) FROM core.competitions
   UNION ALL SELECT 'phases', count(*) FROM core.phases
   UNION ALL SELECT 'poules', count(*) FROM core.poules
   UNION ALL SELECT 'equipes', count(*) FROM core.equipes
   UNION ALL SELECT 'engagements', count(*) FROM core.engagements
   UNION ALL SELECT 'equipes_with_club_id', count(club_id) FROM core.equipes
   UNION ALL SELECT 'warnings_equipes', count(*) FROM core.etl_warnings WHERE entity='equipes'
   UNION ALL SELECT 'warnings_engagements', count(*) FROM core.etl_warnings WHERE entity='engagements';"
```

Expected : counts cohérents (≥3 compétitions, ≥3 phases, ≥3 poules, ≥30 équipes, ≥30 engagements pour --limit=3 compétitions Pro), `equipes_with_club_id` = 0 (résolution différée), `warnings_equipes` ≈ nb_equipes, `warnings_engagements` = 0.

- [ ] **Step 10.3 : Commit**

```bash
git add docs/runbook.md
git commit -m "$(cat <<'EOF'
docs(runbook): sous-section équipes + engagements

T10 : commandes scrape (re-run nécessaire) + 5 ETL dans l'ordre,
SQL de suivi couverture, note sur FK club_id non résolue.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step F.1 : Suite complète**

```bash
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
```

Expected : ~98 tests pass, 0 fail.

- [ ] **Step F.2 : Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

Expected : 0 erreurs.

- [ ] **Step F.3 : Merge sur master**

```bash
git checkout master
git merge --no-ff feat/equipes-engagements -m "Merge feat/equipes-engagements: équipes + engagements depuis pages détail compétition (calendar-button + fallback)"
```

- [ ] **Step F.4 : Optionnel — full re-scrape nocturne**

```bash
npm run scrape -- --entity=competitions --saison=2025-2026
# ~30 min
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
npm run etl -- --entity=equipes      --saison=2025-2026
npm run etl -- --entity=engagements  --saison=2025-2026
```
