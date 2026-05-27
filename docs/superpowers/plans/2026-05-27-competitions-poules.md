# Compétitions, phases & poules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scraper les compétitions de handball sur ffhandball.fr aux 3 niveaux (national, régional, départemental), avec modélisation phases + poules, et alimenter `core.competitions` / `core.phases` / `core.poules`.

**Architecture:** Une commande `npm run scrape -- --entity=competitions` orchestre 2 passes (liste niveaux puis détail compétition). 3 ETLs séparés en aval (`competitions` → `phases` → `poules`). Modèle aligné sur la hiérarchie réelle du site : Compétition → Phase → Poule, via une nouvelle table `core.phases`.

**Tech Stack:** TypeScript 5.7, Cheerio, Zod, Postgres 16, Vitest, tsx (pattern déjà établi par `club-details` / `salles`).

**Spec:** `docs/superpowers/specs/2026-05-27-competitions-poules-design.md`

---

## Workspace setup

- [ ] **Step 0: Créer une branche dédiée**

```bash
git checkout -b feat/competitions-poules master
```

---

### Task 1: Exploration HTML + capture de fixtures

**Pourquoi :** Le pattern URL per-structure (`/regional/{slug}/`) n'a pas été confirmé. Cette tâche valide les hypothèses et capture les fixtures qui serviront aux tests des scrapers.

**Files:**
- Create: `tests/fixtures/ffhandball-competitions-national.html`
- Create: `tests/fixtures/ffhandball-competitions-regional.html`
- Create: `tests/fixtures/ffhandball-competitions-departemental.html`
- Create: `tests/fixtures/ffhandball-competitions-ligue-X.html` (ligue auvergne-rhône-alpes ou autre)
- Create: `tests/fixtures/ffhandball-competition-detail-mono-poule.html` (LIGUE BUTAGAZ ENERGIE ou équivalent)
- Create: `tests/fixtures/ffhandball-competition-detail-multi-poules.html` (compétition régionale ou Nationale 3 avec plusieurs poules)
- Create: `docs/competitions-fields.md` (inventaire des champs disponibles dans le JSON)

- [ ] **Step 1.1 : Fetcher la home `/competitions/` et identifier l'`ext_saison_id`**

```bash
curl -s -A "Mozilla/5.0 ffhandball-pipeline (loric@example.com)" \
  https://www.ffhandball.fr/competitions/ \
  -o /tmp/competitions-home.html
grep -o "ext_saison_id[^,]*" /tmp/competitions-home.html | head -3
```

Noter l'`ext_saison_id` pour la saison 2025-2026 (devrait être `21` d'après l'exploration). Le composant cible est `competitions---saison-selector`.

- [ ] **Step 1.2 : Capturer les 3 fixtures de listes de niveaux**

```bash
SAISON_EXT=21  # ajuster si différent
UA="Mozilla/5.0 ffhandball-pipeline (loric@example.com)"

for niveau in national regional departemental; do
  curl -s -A "$UA" \
    "https://www.ffhandball.fr/competitions/saison-2025-2026-${SAISON_EXT}/${niveau}/" \
    -o "tests/fixtures/ffhandball-competitions-${niveau}.html"
  sleep 2
done
```

Vérifier que chaque fixture contient `<smartfire-component name='competitions---competition-main-menu'`.

- [ ] **Step 1.3 : Identifier le pattern URL per-structure (régional)**

Inspecter le fixture régional pour trouver comment les URLs des ligues sont construites :

```bash
grep -o 'href="[^"]*regional[^"]*"' tests/fixtures/ffhandball-competitions-regional.html | sort -u | head -20
```

L'hypothèse de la spec est `/regional/{slug(libelle)}-{ext_structureId}/`. Si l'inspection révèle un autre pattern (ex: `/regional/{sigle}/`), documenter dans `docs/competitions-fields.md` et utiliser le pattern réel dans T5.

Tester l'URL d'une ligue (ex: LIGUE AUVERGNE-RHONE-ALPES, `ext_structureId=4`) :

```bash
curl -s -A "$UA" -o /tmp/test-ligue.html \
  "https://www.ffhandball.fr/competitions/saison-2025-2026-${SAISON_EXT}/regional/ligue-auvergne-rhone-alpes-4/"
grep -c "competitions---competition-main-menu" /tmp/test-ligue.html
```

Si la page est valide et contient des compétitions, capturer comme fixture :

```bash
cp /tmp/test-ligue.html tests/fixtures/ffhandball-competitions-ligue-X.html
```

Sinon, itérer sur d'autres patterns (slug seul, sigle, etc.) jusqu'à en trouver un qui marche, et documenter.

- [ ] **Step 1.4 : Capturer 2 fixtures de pages détail compétition**

Identifier une compétition mono-poule (ex: LIGUE BUTAGAZ ENERGIE — `ext_competitionId=28227`) et une compétition multi-poules (ex: une N3 régionale ou départementale) depuis les fixtures de listes :

```bash
grep -oE '"ext_competitionId":"[0-9]+"' tests/fixtures/ffhandball-competitions-national.html | head -5
```

Construire les URLs détail et capturer :

```bash
# Mono-poule
curl -s -A "$UA" -o tests/fixtures/ffhandball-competition-detail-mono-poule.html \
  "https://www.ffhandball.fr/competitions/saison-2025-2026-${SAISON_EXT}/national/ligue-butagaz-energie-2025-26-28227/"
sleep 2

# Multi-poules (choisir une compétition adaptée depuis le fixture régional/dép)
curl -s -A "$UA" -o tests/fixtures/ffhandball-competition-detail-multi-poules.html \
  "https://www.ffhandball.fr/competitions/saison-2025-2026-${SAISON_EXT}/<niveau>/<libelle-slug>-<ext_competitionId>/"
```

Vérifier que chaque fixture contient `<smartfire-component name='competitions---poule-selector'`.

- [ ] **Step 1.5 : Documenter l'inventaire des champs**

Créer `docs/competitions-fields.md` (markdown court) avec :

```markdown
# Champs disponibles — ffhandball.fr compétitions

## /competitions/ (home)
- Composant `competitions---saison-selector` → `ext_saison_id`

## /<niveau>/ (pages liste)
Composant `competitions---competition-main-menu` :
- `competitions[].ext_competitionId` (natural key)
- `competitions[].libelle`
- `competitions[].type` (NATIONAL / REGIONAL / DEPARTEMENTAL / COUPE_DE_FRANCE / INTER_LIGUES / INTER_COMITES)
- `competitions[].genre` (FEMININ / MASCULIN / MIXTE)
- `competitions[].code` (ex: "001")
- `competitions[].structureId` (ex: "1" pour national, "4" pour ligue ARA)
- `structures[]` (pour régional/dép) : `ext_structureId`, `libelle`, `sigle`, `code`, `type`

## /<niveau>/<slug>/ (page détail compétition)
Composant `competitions---poule-selector` :
- `phases[].ext_phaseId` (natural key)
- `phases[].id` (id interne, référencé par poule.phaseId)
- `phases[].libelle`
- `phases[].competitionId` (id interne compétition)
- `poules[].ext_pouleId` (natural key)
- `poules[].phaseId` (id interne → mapping à faire vers ext_phaseId)
- `poules[].libelle`
- `poules[].journees` (JSON stringifiée — IGNORÉ dans cette feature)

## Pattern URL per-structure (validé en T1.3)
`/regional/<libelle_slugifié>-<ext_structureId>/`
(ou autre — à confirmer)
```

- [ ] **Step 1.6 : Commit**

```bash
git add tests/fixtures/ffhandball-competitions-*.html \
        tests/fixtures/ffhandball-competition-detail-*.html \
        docs/competitions-fields.md
git commit -m "$(cat <<'EOF'
feat: fixtures + inventaire champs compétitions ffhandball.fr

T1 : capture des fixtures HTML pour les 3 niveaux + 2 pages détail,
validation du pattern URL per-structure, inventaire des champs JSON
exposés via smartfire-component.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Schémas Zod (competition + phase + poule)

**Files:**
- Create: `src/schemas/competition.schema.ts`
- Create: `src/schemas/phase.schema.ts`
- Create: `src/schemas/poule.schema.ts`
- Create: `tests/schemas/competition.schema.test.ts`
- Create: `tests/schemas/phase.schema.test.ts`
- Create: `tests/schemas/poule.schema.test.ts`

- [ ] **Step 2.1 : Écrire les tests du schéma competition (failing)**

```ts
// tests/schemas/competition.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawCompetitionPayloadSchema } from "@/schemas/competition.schema.js";

describe("rawCompetitionPayloadSchema", () => {
  it("accepts a valid national competition payload", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "28227",
      nom: "LIGUE BUTAGAZ ENERGIE 2025-26",
      niveau: "national",
      sexe: "F",
      code: "001",
      ext_structure_id: "1",
      detail_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/",
    });
    expect(r.success).toBe(true);
  });

  it("accepts payload without optional fields", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "9999",
      nom: "X",
      niveau: "regional",
      detail_url: "https://www.ffhandball.fr/x/",
      source_url: "https://www.ffhandball.fr/y/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid niveau", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "1",
      nom: "X",
      niveau: "international",
      detail_url: "https://www.ffhandball.fr/",
      source_url: "https://www.ffhandball.fr/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty ext_competition_id", () => {
    const r = rawCompetitionPayloadSchema.safeParse({
      ext_competition_id: "",
      nom: "X",
      niveau: "national",
      detail_url: "https://x/",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2.2 : Run failing test**

```bash
npx vitest run tests/schemas/competition.schema.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 2.3 : Implémenter `competition.schema.ts`**

```ts
// src/schemas/competition.schema.ts
import { z } from "zod";

export const rawCompetitionPayloadSchema = z.object({
  ext_competition_id: z.string().min(1),
  nom: z.string().min(1),
  niveau: z.enum(["national", "regional", "departemental"]),
  sexe: z.enum(["M", "F", "mixte"]).optional(),
  code: z.string().optional(),
  ext_structure_id: z.string().optional(),
  detail_url: z.string().url(),
  source_url: z.string().url(),
});

export type RawCompetitionPayload = z.infer<typeof rawCompetitionPayloadSchema>;
```

- [ ] **Step 2.4 : Run test passing**

```bash
npx vitest run tests/schemas/competition.schema.test.ts
```

Expected: 4 passed.

- [ ] **Step 2.5 : Écrire les tests du schéma phase (failing)**

```ts
// tests/schemas/phase.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawPhasePayloadSchema } from "@/schemas/phase.schema.js";

describe("rawPhasePayloadSchema", () => {
  it("accepts a valid phase payload", () => {
    const r = rawPhasePayloadSchema.safeParse({
      ext_phase_id: "96749",
      ext_competition_id: "28227",
      nom: "LIGUE BUTAGAZ ENERGIE",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when ext_competition_id is missing", () => {
    const r = rawPhasePayloadSchema.safeParse({
      ext_phase_id: "96749",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when ext_phase_id is empty", () => {
    const r = rawPhasePayloadSchema.safeParse({
      ext_phase_id: "",
      ext_competition_id: "28227",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2.6 : Implémenter `phase.schema.ts` + vérifier**

```ts
// src/schemas/phase.schema.ts
import { z } from "zod";

export const rawPhasePayloadSchema = z.object({
  ext_phase_id: z.string().min(1),
  ext_competition_id: z.string().min(1),
  nom: z.string().min(1),
  source_url: z.string().url(),
});

export type RawPhasePayload = z.infer<typeof rawPhasePayloadSchema>;
```

```bash
npx vitest run tests/schemas/phase.schema.test.ts
```

Expected: 3 passed.

- [ ] **Step 2.7 : Écrire les tests + implémenter `poule.schema.ts`**

```ts
// tests/schemas/poule.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawPoulePayloadSchema } from "@/schemas/poule.schema.js";

describe("rawPoulePayloadSchema", () => {
  it("accepts a valid poule payload", () => {
    const r = rawPoulePayloadSchema.safeParse({
      ext_poule_id: "168256",
      ext_phase_id: "96749",
      nom: "POULE UNIQUE",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when ext_phase_id is missing", () => {
    const r = rawPoulePayloadSchema.safeParse({
      ext_poule_id: "1",
      nom: "X",
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
```

```ts
// src/schemas/poule.schema.ts
import { z } from "zod";

export const rawPoulePayloadSchema = z.object({
  ext_poule_id: z.string().min(1),
  ext_phase_id: z.string().min(1),
  nom: z.string().min(1),
  source_url: z.string().url(),
});

export type RawPoulePayload = z.infer<typeof rawPoulePayloadSchema>;
```

```bash
npx vitest run tests/schemas/poule.schema.test.ts
```

Expected: 2 passed.

- [ ] **Step 2.8 : Commit**

```bash
git add src/schemas/competition.schema.ts src/schemas/phase.schema.ts src/schemas/poule.schema.ts \
        tests/schemas/competition.schema.test.ts tests/schemas/phase.schema.test.ts tests/schemas/poule.schema.test.ts
git commit -m "$(cat <<'EOF'
feat: schémas Zod competition + phase + poule

T2 : payloads raw pour les 3 nouvelles entités du pipeline.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 0008 (raw + core)

**Files:**
- Create: `db/migrations/0008_competitions_phases_poules.sql`

- [ ] **Step 3.1 : Écrire la migration**

```sql
-- db/migrations/0008_competitions_phases_poules.sql

-- 1. Raw tables additionnelles
SELECT raw._create_capture_table('phases');
SELECT raw._create_capture_table('poules');

-- 2. Enrichir core.competitions
ALTER TABLE core.competitions ALTER COLUMN sexe DROP NOT NULL;
ALTER TABLE core.competitions ALTER COLUMN categorie_age DROP NOT NULL;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS ext_structure_id TEXT;
ALTER TABLE core.competitions ADD COLUMN IF NOT EXISTS detail_url TEXT;

-- 3. Supprimer core.poules (vide à ce stade — FK depuis core.engagements sera recréée plus bas)
DROP TABLE IF EXISTS core.poules CASCADE;

-- 4. Créer core.phases
CREATE TABLE IF NOT EXISTS core.phases (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  competition_id  bigint NOT NULL REFERENCES core.competitions(id),
  nom             text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_phases_id_ffhb_saison UNIQUE (id_ffhb, saison_code)
);
CREATE INDEX IF NOT EXISTS idx_phases_competition ON core.phases (competition_id);

-- 5. Re-créer core.poules avec FK vers phases
CREATE TABLE IF NOT EXISTS core.poules (
  id              bigserial PRIMARY KEY,
  id_ffhb         text NOT NULL,
  phase_id        bigint NOT NULL REFERENCES core.phases(id),
  nom             text NOT NULL,
  saison_code     text NOT NULL REFERENCES core.saisons(saison_code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_poules_id_ffhb_saison UNIQUE (id_ffhb, saison_code)
);
CREATE INDEX IF NOT EXISTS idx_poules_phase ON core.poules (phase_id);

-- 6. Recréer la FK core.engagements → core.poules (était cascade-dropped)
ALTER TABLE core.engagements
  ADD CONSTRAINT engagements_poule_id_fkey
  FOREIGN KEY (poule_id) REFERENCES core.poules(id);
```

- [ ] **Step 3.2 : Lancer la migration et vérifier**

```bash
npm run db:migrate
```

Vérifier la structure :

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.phases"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.poules"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.competitions"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt raw.*"
```

Expected output : `core.phases` créé avec `competition_id` FK, `core.poules` avec `phase_id` FK, `core.competitions` avec `code/ext_structure_id/detail_url` ajoutés, `raw.phases` + `raw.poules` listées.

- [ ] **Step 3.3 : Commit**

```bash
git add db/migrations/0008_competitions_phases_poules.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 0008 — phases + poules + enrich competitions

T3 : raw.phases / raw.poules / core.phases + recréation core.poules
avec FK phase_id (au lieu de competition_id) + ALTER core.competitions
(drop NOT NULL sur sexe/categorie_age, add code/ext_structure_id/detail_url).
FK core.engagements → core.poules recréée après cascade.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Scraper `competition-list` — cas national

**Files:**
- Create: `src/scrapers/ffhandball/competition-list.scraper.ts`
- Create: `tests/scrapers/competition-list.scraper.test.ts`

- [ ] **Step 4.1 : Écrire les tests pour le cas national (failing)**

```ts
// tests/scrapers/competition-list.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseCompetitionList,
  parseStructures,
} from "@/scrapers/ffhandball/competition-list.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/";
const EXT_SAISON_ID = "21";

describe("parseCompetitionList — national", () => {
  it("extracts the 20 national competitions", () => {
    const html = fixture("ffhandball-competitions-national.html");
    const list = parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID);
    expect(list.length).toBeGreaterThanOrEqual(15);
    expect(list.length).toBeLessThanOrEqual(40);
  });

  it("maps genre → sexe and type → niveau correctly", () => {
    const html = fixture("ffhandball-competitions-national.html");
    const list = parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID);
    const lbe = list.find((c) => c.ext_competition_id === "28227");
    expect(lbe).toBeDefined();
    expect(lbe!.niveau).toBe("national");
    expect(lbe!.sexe).toBe("F"); // FEMININ
    expect(lbe!.nom).toMatch(/LIGUE BUTAGAZ/i);
    expect(lbe!.detail_url).toMatch(/^https:\/\/www\.ffhandball\.fr\/competitions\/saison-2025-2026-21\/national\/.*-28227\/$/);
  });

  it("returns [] when smartfire-component is absent", () => {
    expect(
      parseCompetitionList("<html><body>nothing</body></html>", "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID),
    ).toEqual([]);
  });

  it("returns [] when attributes JSON is malformed", () => {
    const html = `<smartfire-component name='competitions---competition-main-menu' attributes='{not json'></smartfire-component>`;
    expect(parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID)).toEqual([]);
  });

  it("deduplicates by ext_competition_id", () => {
    const html = fixture("ffhandball-competitions-national.html");
    const list = parseCompetitionList(html, "national", SOURCE_URL, "2025-2026", EXT_SAISON_ID);
    const ids = list.map((c) => c.ext_competition_id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe("parseStructures", () => {
  it("returns [] on national page", () => {
    const html = fixture("ffhandball-competitions-national.html");
    expect(parseStructures(html)).toEqual([]);
  });
});
```

- [ ] **Step 4.2 : Run failing test**

```bash
npx vitest run tests/scrapers/competition-list.scraper.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4.3 : Implémenter `competition-list.scraper.ts`**

```ts
// src/scrapers/ffhandball/competition-list.scraper.ts
import * as cheerio from "cheerio";
import {
  rawCompetitionPayloadSchema,
  type RawCompetitionPayload,
} from "@/schemas/competition.schema.js";

export interface StructureMeta {
  ext_structure_id: string;
  libelle: string;
  sigle?: string;
  code?: string;
  type?: string;
}

const TYPE_TO_NIVEAU: Record<string, "national" | "regional" | "departemental"> = {
  NATIONAL: "national",
  REGIONAL: "regional",
  DEPARTEMENTAL: "departemental",
  COUPE_DE_FRANCE: "national",
  INTER_LIGUES: "national",
  INTER_COMITES: "national",
};

const GENRE_TO_SEXE: Record<string, "M" | "F" | "mixte"> = {
  FEMININ: "F",
  MASCULIN: "M",
  MIXTE: "mixte",
};

export function slugifyLibelle(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadAttributes(html: string): unknown | null {
  const $ = cheerio.load(html);
  const el = $("smartfire-component[name='competitions---competition-main-menu']").first();
  const raw = el.attr("attributes");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseCompetitionList(
  html: string,
  niveau: "national" | "regional" | "departemental",
  sourceUrl: string,
  saison: string,        // ex: "2025-2026"
  extSaisonId: string,   // ex: "21"
): RawCompetitionPayload[] {
  const data = loadAttributes(html);
  if (!data || typeof data !== "object") return [];
  const competitions = (data as { competitions?: unknown }).competitions;
  if (!Array.isArray(competitions)) return [];

  const seen = new Set<string>();
  const out: RawCompetitionPayload[] = [];

  for (const c of competitions) {
    const item = c as Record<string, unknown>;
    const ext = typeof item.ext_competitionId === "string" ? item.ext_competitionId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    const type = typeof item.type === "string" ? item.type : null;
    if (!ext || !libelle || !type) continue;
    if (seen.has(ext)) continue;
    seen.add(ext);

    const mappedNiveau = TYPE_TO_NIVEAU[type];
    if (!mappedNiveau) continue;

    const genre = typeof item.genre === "string" ? item.genre : null;
    const sexe = genre ? GENRE_TO_SEXE[genre] : undefined;
    const code = typeof item.code === "string" ? item.code : undefined;
    const ext_structure_id =
      typeof item.structureId === "string" ? item.structureId : undefined;

    const niveauUrl = mappedNiveau; // url segment same as niveau
    const detail_url = `https://www.ffhandball.fr/competitions/saison-${saison}-${extSaisonId}/${niveauUrl}/${slugifyLibelle(libelle)}-${ext}/`;

    const candidate = {
      ext_competition_id: ext,
      nom: libelle,
      niveau: mappedNiveau,
      sexe,
      code,
      ext_structure_id,
      detail_url,
      source_url: sourceUrl,
    };

    const parsed = rawCompetitionPayloadSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parseStructures(html: string): StructureMeta[] {
  const data = loadAttributes(html);
  if (!data || typeof data !== "object") return [];
  const structures = (data as { structures?: unknown }).structures;
  if (!Array.isArray(structures)) return [];

  const out: StructureMeta[] = [];
  for (const s of structures) {
    const item = s as Record<string, unknown>;
    const ext = typeof item.ext_structureId === "string" ? item.ext_structureId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!ext || !libelle) continue;
    out.push({
      ext_structure_id: ext,
      libelle,
      sigle: typeof item.sigle === "string" ? item.sigle : undefined,
      code: typeof item.code === "string" ? item.code : undefined,
      type: typeof item.type === "string" ? item.type : undefined,
    });
  }
  return out;
}
```

⚠️ Le segment de saison utilise le paramètre `saison` (ex: "2025-2026"), permettant de gérer des saisons futures sans modification de code.

- [ ] **Step 4.4 : Run test passing**

```bash
npx vitest run tests/scrapers/competition-list.scraper.test.ts
```

Expected: 6 passed.

- [ ] **Step 4.5 : Commit**

```bash
git add src/scrapers/ffhandball/competition-list.scraper.ts tests/scrapers/competition-list.scraper.test.ts
git commit -m "$(cat <<'EOF'
feat: scraper competition-list (cas national)

T4 : parseCompetitionList + parseStructures + slugifyLibelle.
Mappings type→niveau et genre→sexe.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Scraper `competition-list` — régional + per-structure

**Files:**
- Modify: `tests/scrapers/competition-list.scraper.test.ts`
- (Re-test après ajustement éventuel de l'URL)

- [ ] **Step 5.1 : Ajouter les tests régional / per-structure**

Ajouter au fichier `tests/scrapers/competition-list.scraper.test.ts` :

```ts
describe("parseCompetitionList — regional", () => {
  it("returns [] competitions but non-empty structures on /regional/ root", () => {
    const html = fixture("ffhandball-competitions-regional.html");
    expect(
      parseCompetitionList(html, "regional", "https://www.ffhandball.fr/competitions/saison-2025-2026-21/regional/", "2025-2026", "21"),
    ).toEqual([]);
  });

  it("extracts competitions on a per-structure regional page", () => {
    const html = fixture("ffhandball-competitions-ligue-X.html");
    const list = parseCompetitionList(html, "regional", "https://x/", "2025-2026", "21");
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.niveau === "regional")).toBe(true);
  });
});

describe("parseStructures — regional", () => {
  it("extracts the 19 ligues from /regional/", () => {
    const html = fixture("ffhandball-competitions-regional.html");
    const structures = parseStructures(html);
    expect(structures.length).toBeGreaterThanOrEqual(15);
    expect(structures.length).toBeLessThanOrEqual(25);
    const ara = structures.find((s) => s.libelle.toUpperCase().includes("AUVERGNE"));
    expect(ara).toBeDefined();
    expect(ara!.ext_structure_id).toMatch(/^\d+$/);
  });
});

describe("parseStructures — departemental", () => {
  it("extracts ~100 comités from /departemental/", () => {
    const html = fixture("ffhandball-competitions-departemental.html");
    const structures = parseStructures(html);
    expect(structures.length).toBeGreaterThanOrEqual(50);
  });
});
```

- [ ] **Step 5.2 : Run tests (devraient déjà passer)**

```bash
npx vitest run tests/scrapers/competition-list.scraper.test.ts
```

Expected: tous les tests pass (l'implémentation T4 couvre déjà tous les cas). Si un test échoue, ajuster l'implémentation.

- [ ] **Step 5.3 : Commit**

```bash
git add tests/scrapers/competition-list.scraper.test.ts
git commit -m "$(cat <<'EOF'
test: competition-list régional + per-structure + départemental

T5 : couverture des 3 cas (regional root vide, per-ligue compétitions,
parseStructures retourne ligues/comités).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Scraper `competition-detail` (phases + poules)

**Files:**
- Create: `src/scrapers/ffhandball/competition-detail.scraper.ts`
- Create: `tests/scrapers/competition-detail.scraper.test.ts`

- [ ] **Step 6.1 : Écrire les tests (failing)**

```ts
// tests/scrapers/competition-detail.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL_MONO =
  "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/";

describe("parseCompetitionDetail", () => {
  it("extracts 1 phase + 1 poule for mono-poule competition (LBE)", () => {
    const html = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(html, SOURCE_URL_MONO, "28227");
    expect(r).not.toBeNull();
    expect(r!.phases).toHaveLength(1);
    expect(r!.phases[0]!.ext_competition_id).toBe("28227");
    expect(r!.poules).toHaveLength(1);
    expect(r!.poules[0]!.ext_phase_id).toBe(r!.phases[0]!.ext_phase_id);
    expect(r!.poules[0]!.nom).toMatch(/POULE/i);
  });

  it("propagates ext_phase_id correctly on multi-poules competition", () => {
    const html = fixture("ffhandball-competition-detail-multi-poules.html");
    const r = parseCompetitionDetail(html, "https://x/", "9999");
    expect(r).not.toBeNull();
    expect(r!.poules.length).toBeGreaterThan(1);
    // Chaque poule doit pointer vers un ext_phase_id présent dans phases
    const phaseIds = new Set(r!.phases.map((p) => p.ext_phase_id));
    for (const p of r!.poules) {
      expect(phaseIds.has(p.ext_phase_id)).toBe(true);
    }
  });

  it("returns null when poule-selector is absent", () => {
    expect(parseCompetitionDetail("<html></html>", "https://x/", "1")).toBeNull();
  });

  it("returns null when attributes JSON is malformed", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='{not json'></smartfire-component>`;
    expect(parseCompetitionDetail(html, "https://x/", "1")).toBeNull();
  });

  it("skips poules whose phaseId has no matching phase (orphan)", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        phases: [{ id: "P1", ext_phaseId: "EP1", libelle: "phase A" }],
        poules: [
          { id: "PO1", ext_pouleId: "EPO1", phaseId: "P1", libelle: "ok" },
          { id: "PO2", ext_pouleId: "EPO2", phaseId: "GHOST", libelle: "orphan" },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseCompetitionDetail(html, "https://x/", "C1");
    expect(r).not.toBeNull();
    expect(r!.phases).toHaveLength(1);
    expect(r!.poules).toHaveLength(1);
    expect(r!.poules[0]!.ext_poule_id).toBe("EPO1");
  });
});
```

- [ ] **Step 6.2 : Run failing test**

```bash
npx vitest run tests/scrapers/competition-detail.scraper.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 6.3 : Implémenter `competition-detail.scraper.ts`**

```ts
// src/scrapers/ffhandball/competition-detail.scraper.ts
import * as cheerio from "cheerio";
import { rawPhasePayloadSchema, type RawPhasePayload } from "@/schemas/phase.schema.js";
import { rawPoulePayloadSchema, type RawPoulePayload } from "@/schemas/poule.schema.js";

export interface CompetitionDetailResult {
  phases: RawPhasePayload[];
  poules: RawPoulePayload[];
}

export function parseCompetitionDetail(
  html: string,
  sourceUrl: string,
  extCompetitionId: string,
): CompetitionDetailResult | null {
  const $ = cheerio.load(html);
  const el = $("smartfire-component[name='competitions---poule-selector']").first();
  const raw = el.attr("attributes");
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const root = data as { phases?: unknown; poules?: unknown };
  const rawPhases = Array.isArray(root.phases) ? root.phases : [];
  const rawPoules = Array.isArray(root.poules) ? root.poules : [];

  // Build id → ext_phaseId mapping
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

  const poules: RawPoulePayload[] = [];
  for (const po of rawPoules) {
    const item = po as Record<string, unknown>;
    const extPouleId = typeof item.ext_pouleId === "string" ? item.ext_pouleId : null;
    const phaseId = typeof item.phaseId === "string" ? item.phaseId : null;
    const libelle = typeof item.libelle === "string" ? item.libelle.trim() : null;
    if (!extPouleId || !phaseId || !libelle) continue;

    const extPhaseId = phaseIdIndex.get(phaseId);
    if (!extPhaseId) continue; // orphan — skip

    const parsed = rawPoulePayloadSchema.safeParse({
      ext_poule_id: extPouleId,
      ext_phase_id: extPhaseId,
      nom: libelle,
      source_url: sourceUrl,
    });
    if (parsed.success) poules.push(parsed.data);
  }

  return { phases, poules };
}
```

- [ ] **Step 6.4 : Run tests passing**

```bash
npx vitest run tests/scrapers/competition-detail.scraper.test.ts
```

Expected: 5 passed.

- [ ] **Step 6.5 : Commit**

```bash
git add src/scrapers/ffhandball/competition-detail.scraper.ts tests/scrapers/competition-detail.scraper.test.ts
git commit -m "$(cat <<'EOF'
feat: scraper competition-detail (phases + poules)

T6 : parseCompetitionDetail extrait phases + poules depuis le composant
competitions---poule-selector. Mapping phase.id → phase.ext_phaseId pour
résoudre les phaseId internes des poules. Orphan poules skippées.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CLI scrape `--entity=competitions`

**Files:**
- Modify: `src/cli/scrape.ts` (ajouter handler `scrapeCompetitions`)
- Modify: `src/cli/args.ts` (si nécessaire — ajouter `--level` option)

- [ ] **Step 7.1 : Vérifier les types CLI existants**

```bash
grep -n "level\|limit\|entity" /Users/loricbondon/Autres/ffhandball/src/cli/args.ts
```

Si `level` n'est pas accepté, ajouter le champ optionnel dans le parser d'arguments.

- [ ] **Step 7.2 : Ajouter `scrapeCompetitions` dans `src/cli/scrape.ts`**

Imports en tête de fichier :

```ts
import {
  parseCompetitionList,
  parseStructures,
  slugifyLibelle,
} from "@/scrapers/ffhandball/competition-list.scraper.js";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";
```

Nouveau handler à ajouter avant `main()` :

```ts
async function scrapeCompetitions(
  saison: string,
  opts: { level?: "national" | "regional" | "departemental"; limit?: number },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "competitions",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting competitions scrape");

  try {
    // 1. Resolve ext_saison_id from /competitions/ home
    const homeRes = await fetchHtml("https://www.ffhandball.fr/competitions/");
    await run.incrementPages(1);
    const extSaisonId = extractExtSaisonId(homeRes.body, saison);
    if (!extSaisonId) {
      throw new Error(`ext_saison_id introuvable pour saison=${saison}`);
    }
    logger.info({ ext_saison_id: extSaisonId }, "resolved ext_saison_id");

    const levels: Array<"national" | "regional" | "departemental"> = opts.level
      ? [opts.level]
      : ["national", "regional", "departemental"];

    // 2. Passe A — listes par niveau
    let totalCompetitions = 0;
    const competitionsToDetail: Array<{
      ext_competition_id: string;
      detail_url: string;
    }> = [];

    for (const niveau of levels) {
      const listUrl = `https://www.ffhandball.fr/competitions/saison-${saison}-${extSaisonId}/${niveau}/`;
      const listRes = await fetchHtml(listUrl);
      await run.incrementPages(1);

      if (niveau === "national") {
        const comps = parseCompetitionList(listRes.body, "national", listUrl, saison, extSaisonId);
        for (const c of comps) {
          await insertRaw("competitions", {
            scrape_run_id: run.id,
            source_url: c.source_url,
            source_site: "ffhandball.fr",
            natural_key: c.ext_competition_id,
            payload: c,
            saison,
            http_status: listRes.status,
          });
          competitionsToDetail.push({
            ext_competition_id: c.ext_competition_id,
            detail_url: c.detail_url,
          });
          totalCompetitions++;
        }
      } else {
        const structures = parseStructures(listRes.body);
        for (const s of structures) {
          const structUrl = `https://www.ffhandball.fr/competitions/saison-${saison}-${extSaisonId}/${niveau}/${slugifyLibelle(s.libelle)}-${s.ext_structure_id}/`;
          const structRes = await fetchHtml(structUrl);
          await run.incrementPages(1);
          if (structRes.status >= 400) {
            logger.warn({ url: structUrl, status: structRes.status }, "per-structure page failed");
            continue;
          }
          const comps = parseCompetitionList(structRes.body, niveau, structUrl, saison, extSaisonId);
          for (const c of comps) {
            await insertRaw("competitions", {
              scrape_run_id: run.id,
              source_url: c.source_url,
              source_site: "ffhandball.fr",
              natural_key: c.ext_competition_id,
              payload: c,
              saison,
              http_status: structRes.status,
            });
            competitionsToDetail.push({
              ext_competition_id: c.ext_competition_id,
              detail_url: c.detail_url,
            });
            totalCompetitions++;
          }
        }
      }
    }
    logger.info({ totalCompetitions }, "passe A done");

    // 3. Passe B — détails (phases + poules)
    let competitions = competitionsToDetail;
    if (opts.limit !== undefined) competitions = competitions.slice(0, opts.limit);

    let insertedPhases = 0;
    let insertedPoules = 0;
    let parseFailed = 0;
    for (const { ext_competition_id, detail_url } of competitions) {
      const res = await fetchHtml(detail_url);
      await run.incrementPages(1);
      if (res.status >= 400) {
        logger.warn({ detail_url, status: res.status }, "detail page failed");
        continue;
      }
      const parsed = parseCompetitionDetail(res.body, detail_url, ext_competition_id);
      if (!parsed) {
        parseFailed++;
        logger.warn({ ext_competition_id }, "parseCompetitionDetail returned null");
        continue;
      }
      for (const ph of parsed.phases) {
        await insertRaw("phases", {
          scrape_run_id: run.id,
          source_url: ph.source_url,
          source_site: "ffhandball.fr",
          natural_key: ph.ext_phase_id,
          payload: ph,
          saison,
          http_status: res.status,
        });
        insertedPhases++;
      }
      for (const po of parsed.poules) {
        await insertRaw("poules", {
          scrape_run_id: run.id,
          source_url: po.source_url,
          source_site: "ffhandball.fr",
          natural_key: po.ext_poule_id,
          payload: po,
          saison,
          http_status: res.status,
        });
        insertedPoules++;
      }
    }

    logger.info(
      { totalCompetitions, insertedPhases, insertedPoules, parseFailed },
      "competitions scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "competitions scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}

function extractExtSaisonId(html: string, saisonCode: string): string | null {
  // Le composant `competitions---saison-selector` contient toutes les saisons.
  // On cherche celle qui matche saisonCode (ex: "2025-2026").
  const $ = (require("cheerio") as typeof import("cheerio")).load(html);
  const el = $("smartfire-component[name='competitions---saison-selector']").first();
  const raw = el.attr("attributes");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { saisons?: Array<{ libelle?: string; ext_saisonId?: string }> };
    if (!Array.isArray(data.saisons)) return null;
    const target = saisonCode.replace("-", "/"); // ex: 2025/2026
    const match = data.saisons.find(
      (s) =>
        typeof s.libelle === "string" &&
        (s.libelle === saisonCode || s.libelle === target || s.libelle.replace("/", "-") === saisonCode),
    );
    return match?.ext_saisonId ?? null;
  } catch {
    return null;
  }
}
```

⚠️ La fonction `extractExtSaisonId` utilise un `require` inline pour éviter d'ajouter un import global cheerio si le fichier ne l'avait pas — si cheerio est déjà importé, remplacer par l'import standard. Ajuster si le format du `libelle` saison est différent (T1 doit avoir documenté le format réel).

Ajouter le dispatch dans `main()` :

```ts
  } else if (args.entity === "competitions") {
    await scrapeCompetitions(args.saison, {
      level: args.level as "national" | "regional" | "departemental" | undefined,
      limit: args.limit,
    });
```

- [ ] **Step 7.3 : Mettre à jour `src/cli/args.ts` si nécessaire**

Si `--level` n'est pas reconnu, ajouter dans le parser :

```ts
// Dans args.ts, étendre le parser :
//   --level=national|regional|departemental  (optional)
//   --limit=N                                  (déjà existant)
```

(Lire d'abord le fichier pour adapter la modification au parser existant.)

- [ ] **Step 7.4 : Tester localement sur un seul niveau**

```bash
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=3
```

Vérifier en base :

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*), saison FROM raw.competitions GROUP BY saison;"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*), saison FROM raw.phases GROUP BY saison;"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*), saison FROM raw.poules GROUP BY saison;"
```

Expected : ≥3 lignes dans `raw.competitions` (les 3 premières du `--limit=3`), au moins 3 lignes dans `raw.phases` et `raw.poules`.

- [ ] **Step 7.5 : Commit**

```bash
git add src/cli/scrape.ts src/cli/args.ts
git commit -m "$(cat <<'EOF'
feat(cli): scrape --entity=competitions

T7 : orchestration 2 passes (liste niveaux + per-structure pour reg/dép,
puis détail par compétition). Options --level et --limit. Pattern aligné
sur club-details.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: ETL `competitions`

**Files:**
- Create: `src/etl/competitions.etl.ts`
- Create: `tests/etl/competitions.etl.test.ts`

- [ ] **Step 8.1 : Écrire les tests (failing)**

```ts
// tests/etl/competitions.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";

const SAISON = "2025-2026";

async function setupBaseSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
}

async function insertRawCompetition(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.competitions
       (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runCompetitionsEtl", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.competitions, core.etl_runs, core.etl_rejets, core.etl_warnings RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.competitions`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setupBaseSaison();
  });

  it("inserts a competition from a valid payload", async () => {
    await insertRawCompetition(
      {
        ext_competition_id: "28227",
        nom: "LIGUE BUTAGAZ ENERGIE 2025-26",
        niveau: "national",
        sexe: "F",
        code: "001",
        ext_structure_id: "1",
        detail_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/",
        source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/",
      },
      "28227",
    );
    const report = await runCompetitionsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.rows_rejected).toBe(0);

    const row = await query<{ id_ffhb: string; nom: string; niveau: string; sexe: string }>(
      `SELECT id_ffhb, nom, niveau, sexe FROM core.competitions WHERE id_ffhb = '28227'`,
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.niveau).toBe("national");
    expect(row.rows[0]!.sexe).toBe("F");
  });

  it("rejects invalid payload to etl_rejets", async () => {
    await insertRawCompetition({ junk: true } as object, "BAD");
    const report = await runCompetitionsEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
    const rej = await query(`SELECT count(*) FROM core.etl_rejets WHERE entity = 'competitions'`);
    expect(Number((rej.rows[0] as { count: string }).count)).toBe(1);
  });

  it("is idempotent (re-run does not duplicate)", async () => {
    await insertRawCompetition(
      {
        ext_competition_id: "X1",
        nom: "Test",
        niveau: "regional",
        detail_url: "https://x/",
        source_url: "https://x/",
      },
      "X1",
    );
    await runCompetitionsEtl(SAISON);
    await runCompetitionsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.competitions`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });
});
```

⚠️ `afterAll(closePool)` doit être placé dans le **dernier** describe du suite global (cf. salles.etl.test.ts). Si c'est le seul fichier ETL pour competitions à ce stade, l'ajouter ici ; sinon, l'ajouter dans `tests/etl/poules.etl.test.ts` (T10).

- [ ] **Step 8.2 : Run failing test**

```bash
npx vitest run tests/etl/competitions.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 8.3 : Implémenter `competitions.etl.ts`**

```ts
// src/etl/competitions.etl.ts
import { query } from "@/db/client.js";
import {
  rawCompetitionPayloadSchema,
  type RawCompetitionPayload,
} from "@/schemas/competition.schema.js";
import { logger } from "@/lib/logger.js";

interface RawCompetitionRow {
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

export async function runCompetitionsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('competitions', $1) RETURNING id`,
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
    const rawRows = await query<RawCompetitionRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.competitions
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawCompetitionPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets
             (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'competitions',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawCompetitionPayload = parsed.data;

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.competitions
           (id_ffhb, nom, niveau, sexe, categorie_age, saison_code, code, ext_structure_id, detail_url, last_seen_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom = EXCLUDED.nom,
             niveau = EXCLUDED.niveau,
             sexe = COALESCE(EXCLUDED.sexe, core.competitions.sexe),
             saison_code = EXCLUDED.saison_code,
             code = COALESCE(EXCLUDED.code, core.competitions.code),
             ext_structure_id = COALESCE(EXCLUDED.ext_structure_id, core.competitions.ext_structure_id),
             detail_url = COALESCE(EXCLUDED.detail_url, core.competitions.detail_url),
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.competitions.nom IS DISTINCT FROM EXCLUDED.nom
                 OR core.competitions.niveau IS DISTINCT FROM EXCLUDED.niveau
                 OR (EXCLUDED.sexe IS NOT NULL AND core.competitions.sexe IS DISTINCT FROM EXCLUDED.sexe)
                 OR (EXCLUDED.code IS NOT NULL AND core.competitions.code IS DISTINCT FROM EXCLUDED.code)
                 OR (EXCLUDED.ext_structure_id IS NOT NULL AND core.competitions.ext_structure_id IS DISTINCT FROM EXCLUDED.ext_structure_id)
                 OR (EXCLUDED.detail_url IS NOT NULL AND core.competitions.detail_url IS DISTINCT FROM EXCLUDED.detail_url)
               THEN now()
               ELSE core.competitions.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [
          p.ext_competition_id,
          p.nom,
          p.niveau,
          p.sexe ?? null,
          saison,
          p.code ?? null,
          p.ext_structure_id ?? null,
          p.detail_url,
        ],
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
             rows_inserted=$5, rows_updated=$6, rows_noop=$7,
             warnings_count=$8
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

    logger.info(report, "competitions ETL done");
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

- [ ] **Step 8.4 : Run tests passing**

```bash
npx vitest run tests/etl/competitions.etl.test.ts
```

Expected: 3 passed.

- [ ] **Step 8.5 : Commit**

```bash
git add src/etl/competitions.etl.ts tests/etl/competitions.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL competitions

T8 : UPSERT idempotent core.competitions par id_ffhb. COALESCE +
CASE updated_at conditionnel sur les champs nullable.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: ETL `phases` (avec résolution FK)

**Files:**
- Create: `src/etl/phases.etl.ts`
- Create: `tests/etl/phases.etl.test.ts`

- [ ] **Step 9.1 : Écrire les tests (failing)**

```ts
// tests/etl/phases.etl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
}

async function seedCompetition(id_ffhb: string): Promise<void> {
  await query(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ($1, 'X', 'national', $2)
     ON CONFLICT (id_ffhb) DO NOTHING`,
    [id_ffhb, SAISON],
  );
}

async function insertRawPhase(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.phases (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runPhasesEtl", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.phases, core.competitions, core.etl_runs, core.etl_warnings RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.phases`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setupSaison();
  });

  it("inserts a phase when competition FK resolves", async () => {
    await seedCompetition("28227");
    await insertRawPhase(
      {
        ext_phase_id: "96749",
        ext_competition_id: "28227",
        nom: "LIGUE BUTAGAZ ENERGIE",
        source_url: "https://x/",
      },
      "96749",
    );
    const report = await runPhasesEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    const row = await query(`SELECT * FROM core.phases WHERE id_ffhb = '96749'`);
    expect(row.rowCount).toBe(1);
  });

  it("warns and skips when competition FK does not resolve", async () => {
    await insertRawPhase(
      {
        ext_phase_id: "99999",
        ext_competition_id: "GHOST",
        nom: "Orphan",
        source_url: "https://x/",
      },
      "99999",
    );
    const report = await runPhasesEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
    const warns = await query(`SELECT * FROM core.etl_warnings WHERE entity = 'phases'`);
    expect(warns.rowCount).toBe(1);
  });

  it("is idempotent", async () => {
    await seedCompetition("28227");
    await insertRawPhase(
      {
        ext_phase_id: "96749",
        ext_competition_id: "28227",
        nom: "x",
        source_url: "https://x/",
      },
      "96749",
    );
    await runPhasesEtl(SAISON);
    await runPhasesEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.phases`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });
});
```

- [ ] **Step 9.2 : Run failing test**

```bash
npx vitest run tests/etl/phases.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 9.3 : Implémenter `phases.etl.ts`**

```ts
// src/etl/phases.etl.ts
import { query } from "@/db/client.js";
import { rawPhasePayloadSchema, type RawPhasePayload } from "@/schemas/phase.schema.js";
import { logger } from "@/lib/logger.js";

interface RawPhaseRow {
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

async function resolveCompetitionId(
  idFfhb: string,
  saison: string,
): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.competitions WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

export async function runPhasesEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('phases', $1) RETURNING id`,
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
    const rawRows = await query<RawPhaseRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.phases
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawPhasePayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'phases',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawPhasePayload = parsed.data;
      const competition_id = await resolveCompetitionId(p.ext_competition_id, saison);
      if (competition_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'phases',$2,$3)`,
          [etl_run_id, p.ext_phase_id, `competition ${p.ext_competition_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (id_ffhb, saison_code) DO UPDATE
         SET competition_id = EXCLUDED.competition_id,
             nom = EXCLUDED.nom,
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.phases.competition_id IS DISTINCT FROM EXCLUDED.competition_id
                 OR core.phases.nom IS DISTINCT FROM EXCLUDED.nom
               THEN now()
               ELSE core.phases.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.ext_phase_id, competition_id, p.nom, saison],
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

    logger.info(report, "phases ETL done");
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

- [ ] **Step 9.4 : Run tests passing**

```bash
npx vitest run tests/etl/phases.etl.test.ts
```

Expected: 3 passed.

- [ ] **Step 9.5 : Commit**

```bash
git add src/etl/phases.etl.ts tests/etl/phases.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL phases (avec résolution FK competition)

T9 : raw.phases → core.phases. FK competition_id résolue via
core.competitions.id_ffhb. Warning + skip si non résolue.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: ETL `poules` (avec résolution FK)

**Files:**
- Create: `src/etl/poules.etl.ts`
- Create: `tests/etl/poules.etl.test.ts`

- [ ] **Step 10.1 : Écrire les tests (failing)**

```ts
// tests/etl/poules.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT (saison_code) DO NOTHING`,
    [SAISON],
  );
}

async function seedCompetitionAndPhase(extPhaseId: string): Promise<void> {
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1', 'C', 'national', $1)
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ($1, $2, 'P', $3)
     ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
    [extPhaseId, comp.rows[0]!.id, SAISON],
  );
}

async function insertRawPoule(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','competitions',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.poules (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runPoulesEtl", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.poules`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setupSaison();
  });

  it("inserts a poule when phase FK resolves", async () => {
    await seedCompetitionAndPhase("PH1");
    await insertRawPoule(
      { ext_poule_id: "PO1", ext_phase_id: "PH1", nom: "POULE UNIQUE", source_url: "https://x/" },
      "PO1",
    );
    const report = await runPoulesEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    const row = await query(`SELECT * FROM core.poules WHERE id_ffhb = 'PO1'`);
    expect(row.rowCount).toBe(1);
  });

  it("warns and skips when phase FK does not resolve", async () => {
    await insertRawPoule(
      { ext_poule_id: "X", ext_phase_id: "GHOST", nom: "x", source_url: "https://x/" },
      "X",
    );
    const report = await runPoulesEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("is idempotent", async () => {
    await seedCompetitionAndPhase("PH1");
    await insertRawPoule(
      { ext_poule_id: "PO1", ext_phase_id: "PH1", nom: "x", source_url: "https://x/" },
      "PO1",
    );
    await runPoulesEtl(SAISON);
    await runPoulesEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.poules`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  afterAll(async () => {
    await closePool();
  });
});
```

- [ ] **Step 10.2 : Run failing test**

```bash
npx vitest run tests/etl/poules.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 10.3 : Implémenter `poules.etl.ts`**

```ts
// src/etl/poules.etl.ts
import { query } from "@/db/client.js";
import { rawPoulePayloadSchema, type RawPoulePayload } from "@/schemas/poule.schema.js";
import { logger } from "@/lib/logger.js";

interface RawPouleRow {
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

async function resolvePhaseId(idFfhb: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.phases WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

export async function runPoulesEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('poules', $1) RETURNING id`,
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
    const rawRows = await query<RawPouleRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.poules
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawPoulePayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'poules',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawPoulePayload = parsed.data;
      const phase_id = await resolvePhaseId(p.ext_phase_id, saison);
      if (phase_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'poules',$2,$3)`,
          [etl_run_id, p.ext_poule_id, `phase ${p.ext_phase_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code, last_seen_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (id_ffhb, saison_code) DO UPDATE
         SET phase_id = EXCLUDED.phase_id,
             nom = EXCLUDED.nom,
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.poules.phase_id IS DISTINCT FROM EXCLUDED.phase_id
                 OR core.poules.nom IS DISTINCT FROM EXCLUDED.nom
               THEN now()
               ELSE core.poules.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.ext_poule_id, phase_id, p.nom, saison],
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

    logger.info(report, "poules ETL done");
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

- [ ] **Step 10.4 : Run tests passing**

```bash
npx vitest run tests/etl/poules.etl.test.ts
```

Expected: 3 passed.

- [ ] **Step 10.5 : Commit**

```bash
git add src/etl/poules.etl.ts tests/etl/poules.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL poules (avec résolution FK phase)

T10 : raw.poules → core.poules. FK phase_id résolue via
core.phases.id_ffhb. Warning + skip si non résolue.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: CLI etl — dispatch des 3 nouvelles entités

**Files:**
- Modify: `src/cli/etl.ts`

- [ ] **Step 11.1 : Lire le fichier existant**

```bash
cat /Users/loricbondon/Autres/ffhandball/src/cli/etl.ts
```

- [ ] **Step 11.2 : Ajouter les 3 dispatchs**

Imports en tête :

```ts
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";
```

Dans `main()`, ajouter les branches :

```ts
  } else if (args.entity === "competitions") {
    await runCompetitionsEtl(args.saison);
  } else if (args.entity === "phases") {
    await runPhasesEtl(args.saison);
  } else if (args.entity === "poules") {
    await runPoulesEtl(args.saison);
```

- [ ] **Step 11.3 : Tester en exécutant la chaîne complète sur dev**

```bash
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
```

Vérifier :

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*) AS competitions FROM core.competitions;
   SELECT count(*) AS phases       FROM core.phases;
   SELECT count(*) AS poules       FROM core.poules;
   SELECT entity, count(*) FROM core.etl_warnings GROUP BY entity;"
```

- [ ] **Step 11.4 : Commit**

```bash
git add src/cli/etl.ts
git commit -m "$(cat <<'EOF'
feat(cli): etl --entity=competitions|phases|poules

T11 : dispatch des 3 nouvelles ETLs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Test intégration end-to-end

**Files:**
- Create: `tests/integration/competitions-end-to-end.test.ts`

- [ ] **Step 12.1 : Écrire le test (failing)**

```ts
// tests/integration/competitions-end-to-end.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, closePool } from "@/db/client.js";
import { parseCompetitionList } from "@/scrapers/ffhandball/competition-list.scraper.js";
import { parseCompetitionDetail } from "@/scrapers/ffhandball/competition-detail.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";

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

describe("competitions end-to-end", () => {
  beforeEach(async () => {
    await query(`TRUNCATE core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await query(`DELETE FROM raw.competitions; DELETE FROM raw.phases; DELETE FROM raw.poules;`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='competitions'`);
    await setup();
  });

  it("scrapes → ETLs → core in correct order", async () => {
    const run_id = await startRun();

    // 1. parser+inserer competitions depuis fixture national
    const compHtml = fixture("ffhandball-competitions-national.html");
    const sourceUrl = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/";
    const comps = parseCompetitionList(compHtml, "national", sourceUrl, "2025-2026", "21");
    for (const c of comps) {
      await insertRaw("competitions", {
        scrape_run_id: run_id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.ext_competition_id,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    expect(comps.length).toBeGreaterThan(0);

    // 2. Pour une compétition connue (LBE), parser+inserer phases+poules
    const lbe = comps.find((c) => c.ext_competition_id === "28227");
    expect(lbe).toBeDefined();
    const detailHtml = fixture("ffhandball-competition-detail-mono-poule.html");
    const r = parseCompetitionDetail(detailHtml, lbe!.detail_url, lbe!.ext_competition_id);
    expect(r).not.toBeNull();
    for (const ph of r!.phases) {
      await insertRaw("phases", {
        scrape_run_id: run_id,
        source_url: ph.source_url,
        source_site: "ffhandball.fr",
        natural_key: ph.ext_phase_id,
        payload: ph,
        saison: SAISON,
        http_status: 200,
      });
    }
    for (const po of r!.poules) {
      await insertRaw("poules", {
        scrape_run_id: run_id,
        source_url: po.source_url,
        source_site: "ffhandball.fr",
        natural_key: po.ext_poule_id,
        payload: po,
        saison: SAISON,
        http_status: 200,
      });
    }

    // 3. Run les 3 ETLs dans l'ordre
    const c1 = await runCompetitionsEtl(SAISON);
    expect(c1.rows_inserted).toBeGreaterThan(0);

    const p1 = await runPhasesEtl(SAISON);
    expect(p1.rows_inserted).toBeGreaterThan(0);
    expect(p1.warnings_count).toBe(0); // FK competition résolue

    const po1 = await runPoulesEtl(SAISON);
    expect(po1.rows_inserted).toBeGreaterThan(0);
    expect(po1.warnings_count).toBe(0); // FK phase résolue

    // 4. Vérifier l'état final
    const finalComp = await query(`SELECT * FROM core.competitions WHERE id_ffhb = '28227'`);
    expect(finalComp.rowCount).toBe(1);
    const finalPhase = await query(`SELECT * FROM core.phases WHERE id_ffhb = $1`, [
      r!.phases[0]!.ext_phase_id,
    ]);
    expect(finalPhase.rowCount).toBe(1);
    const finalPoule = await query(`SELECT * FROM core.poules WHERE id_ffhb = $1`, [
      r!.poules[0]!.ext_poule_id,
    ]);
    expect(finalPoule.rowCount).toBe(1);
  });

  it("is idempotent end-to-end (re-run = same counts)", async () => {
    const run_id = await startRun();
    const compHtml = fixture("ffhandball-competitions-national.html");
    const comps = parseCompetitionList(compHtml, "national", "https://x/", "2025-2026", "21");
    for (const c of comps) {
      await insertRaw("competitions", {
        scrape_run_id: run_id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.ext_competition_id,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }
    await runCompetitionsEtl(SAISON);
    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.competitions`)).rows[0]!.count;
    await runCompetitionsEtl(SAISON);
    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.competitions`)).rows[0]!.count;
    expect(after).toBe(before);
  });

  afterAll(async () => {
    await closePool();
  });
});
```

- [ ] **Step 12.2 : Run failing test, fixer si nécessaire**

```bash
npx vitest run tests/integration/competitions-end-to-end.test.ts
```

Si échec sur ordre des `afterAll(closePool)` entre fichiers de test, déplacer `afterAll(closePool)` ici uniquement (le retirer de `tests/etl/poules.etl.test.ts`).

Expected: 2 passed.

- [ ] **Step 12.3 : Run full suite pour s'assurer qu'aucune régression**

```bash
npm test
```

Expected: tous les tests pass (au moins 60+ tests entre salles + competitions).

- [ ] **Step 12.4 : Commit**

```bash
git add tests/integration/competitions-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test: intégration end-to-end competitions/phases/poules

T12 : scrape (fixtures) → 3 ETL → core. Couvre le chemin complet
et l'idempotence du re-run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Runbook section

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 13.1 : Ajouter la section "Scrape compétitions / phases / poules"**

Ajouter à la fin de `docs/runbook.md`, après la section enrichissement salles :

```markdown
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
```

- [ ] **Step 13.2 : Commit**

```bash
git add docs/runbook.md
git commit -m "$(cat <<'EOF'
docs(runbook): section compétitions / phases / poules

T13 : commandes scrape + ETL dans l'ordre, SQL de suivi de
couverture, notes opérationnelles.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step F.1 : Run full test suite**

```bash
npm test
```

Expected: tous les tests pass (60+).

- [ ] **Step F.2 : Run linter / typecheck**

```bash
npm run lint
npm run typecheck
```

Expected: 0 erreurs.

- [ ] **Step F.3 : Smoke test scrape sur 1 compétition**

```bash
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=1
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
```

Vérifier en SQL :

```sql
SELECT 'competitions' AS t, count(*) FROM core.competitions
UNION ALL SELECT 'phases', count(*) FROM core.phases
UNION ALL SELECT 'poules', count(*) FROM core.poules
UNION ALL SELECT 'warnings', count(*) FROM core.etl_warnings WHERE etl_run_id IN (SELECT id FROM core.etl_runs ORDER BY id DESC LIMIT 3);
```

Expected: au moins 1 compétition, 1 phase, 1 poule, 0 warning (ou warnings expliqués).

- [ ] **Step F.4 : Merge sur master**

```bash
git checkout master
git merge --no-ff feat/competitions-poules -m "Merge feat/competitions-poules: scraping des compétitions ffhandball.fr (3 niveaux) + phases + poules"
```

- [ ] **Step F.5 : Optionnel — full run nocturne**

```bash
npm run scrape -- --entity=competitions --saison=2025-2026
# attendre ~25-35 min
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
```
