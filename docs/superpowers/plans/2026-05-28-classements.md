# Classements par poule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extraire les classements par poule depuis `competitions---classement` (3 niveaux), résoudre FK poule + équipe, alimenter `core.classements` (enrichie de `id_ffhb` + `dernieres_rencontres` via migration 0012).

**Architecture:** Nouveau scraper `classement.scraper.ts` (pattern identique à `rencontre-list.scraper.ts`, plus simple — 1 seul fetch par poule, pas d'iteration). ETL avec double résolution FK et UPSERT par PK composite `(poule_id, equipe_id)`.

**Tech Stack:** TypeScript 5.7, Cheerio, Zod, Postgres 16, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-classements-design.md`

**Pré-requis :** branche `feat/classements` créée. `core.poules` et `core.equipes` doivent être peuplées (au moins partiellement) pour les smoke tests.

---

### Task 1: Fixture LBE classement

**Files:**
- Create: `tests/fixtures/ffhandball-poule-classement-lbe.html`

- [ ] **Step 1.1 : Fetcher la page classement LBE**

```bash
UA="Mozilla/5.0 ffhandball-pipeline (loric@example.com)"
curl -s -A "$UA" \
  "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/classements/" \
  -o tests/fixtures/ffhandball-poule-classement-lbe.html
```

- [ ] **Step 1.2 : Vérifier le contenu**

```bash
# Vérifier présence des 2 composants requis
grep -c "competitions---classement\|competitions---poule-selector" tests/fixtures/ffhandball-poule-classement-lbe.html

# Vérifier que classements[] contient 14 lignes
node -e "
const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('tests/fixtures/ffhandball-poule-classement-lbe.html', 'utf8');
const \$ = cheerio.load(html);
const el = \$('smartfire-component[name=\"competitions---classement\"]').first();
const data = JSON.parse(el.attr('attributes'));
console.log('Nombre de classements:', data.classements?.length);
console.log('1re place:', JSON.stringify(data.classements?.[0], null, 2));
"
```

Expected : 14 classements, 1re place LBE = BREST BRETAGNE HANDBALL avec 73 points.

- [ ] **Step 1.3 : Commit**

```bash
git add tests/fixtures/ffhandball-poule-classement-lbe.html
git commit -m "$(cat <<'EOF'
feat: fixture classement LBE poule 168256

T1 : capture HTML pour TDD scraper classement.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Schéma Zod classement

**Files:**
- Create: `src/schemas/classement.schema.ts`
- Create: `tests/schemas/classement.schema.test.ts`

- [ ] **Step 2.1 : Tests (failing)**

```ts
// tests/schemas/classement.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawClassementPayloadSchema } from "@/schemas/classement.schema.js";

describe("rawClassementPayloadSchema", () => {
  it("accepts a complete payload with strings (source format)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "59679118",
      ext_poule_id: "168256",
      ext_equipe_id: "1949474",
      position: "1",
      points: "73",
      joues: "25",
      gagnes: "24",
      nuls: "0",
      perdus: "1",
      buts_pour: "849",
      buts_contre: "603",
      dernieres_rencontres: "-1;1;1;1;1",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/classements/",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.position).toBe(1);
      expect(r.data.points).toBe(73);
      expect(r.data.joues).toBe(25);
      expect(r.data.buts_pour).toBe(849);
    }
  });

  it("accepts payload with numbers directly (numeric input)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "X",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: 1,
      points: 0,
      joues: 0,
      gagnes: 0,
      nuls: 0,
      perdus: 0,
      buts_pour: 0,
      buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("accepts payload without dernieres_rencontres (optional)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "X",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: 1,
      points: 0,
      joues: 0,
      gagnes: 0,
      nuls: 0,
      perdus: 0,
      buts_pour: 0,
      buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty ext_classement_id", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: 1,
      points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
      buts_pour: 0, buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when position is malformed (non-numeric string)", () => {
    const r = rawClassementPayloadSchema.safeParse({
      ext_classement_id: "X",
      ext_poule_id: "P",
      ext_equipe_id: "E",
      position: "abc",
      points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
      buts_pour: 0, buts_contre: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2.2 : Run failing**

```bash
npx vitest run tests/schemas/classement.schema.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 2.3 : Implémenter `classement.schema.ts`**

```ts
// src/schemas/classement.schema.ts
import { z } from "zod";

// Helper preprocess pour gérer strings et numbers (source ffhandball.fr expose en strings)
const intFromStringOrNumber = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  },
  z.number().int(),
);

export const rawClassementPayloadSchema = z.object({
  ext_classement_id: z.string().min(1),
  ext_poule_id: z.string().min(1),
  ext_equipe_id: z.string().min(1),

  position: intFromStringOrNumber,
  points: intFromStringOrNumber,
  joues: intFromStringOrNumber,
  gagnes: intFromStringOrNumber,
  nuls: intFromStringOrNumber,
  perdus: intFromStringOrNumber,
  buts_pour: intFromStringOrNumber,
  buts_contre: intFromStringOrNumber,

  dernieres_rencontres: z.string().optional(),

  source_url: z.string().url(),
});
export type RawClassementPayload = z.infer<typeof rawClassementPayloadSchema>;
```

- [ ] **Step 2.4 : Run passing**

```bash
npx vitest run tests/schemas/classement.schema.test.ts
```

Expected: 5 passed.

- [ ] **Step 2.5 : Commit**

```bash
git add src/schemas/classement.schema.ts tests/schemas/classement.schema.test.ts
git commit -m "$(cat <<'EOF'
feat: schéma Zod classement (raw.classements payload)

T2 : payload avec helper preprocess pour coercer les strings source en
numbers. dernieres_rencontres optionnel. Pattern identique à
match.schema.ts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 0012 (enrichir core.classements)

**Files:**
- Create: `db/migrations/0012_classements_enrichissement.sql`

- [ ] **Step 3.1 : Pré-vérification**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.classements"
```

Confirmer : pas de colonne `id_ffhb` ni `dernieres_rencontres`.

- [ ] **Step 3.2 : Écrire la migration**

```sql
-- db/migrations/0012_classements_enrichissement.sql

ALTER TABLE core.classements ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.classements ADD COLUMN IF NOT EXISTS dernieres_rencontres TEXT;

ALTER TABLE core.classements ADD CONSTRAINT uq_classements_id_ffhb UNIQUE (id_ffhb);
```

- [ ] **Step 3.3 : Lancer + vérifier**

```bash
npm run db:migrate
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.classements"
```

Expected :
- Colonnes `id_ffhb text` et `dernieres_rencontres text` ajoutées
- Contrainte UNIQUE `uq_classements_id_ffhb` présente

- [ ] **Step 3.4 : Commit**

```bash
git add db/migrations/0012_classements_enrichissement.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 0012 — core.classements ajoute id_ffhb + dernieres_rencontres

T3 : 2 colonnes nullable ajoutées. id_ffhb = ext_classementId source
(traçabilité, UNIQUE). dernieres_rencontres = string brute "-1;1;1;1;1"
(forme récente 5 derniers résultats, pour visualisation API future).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Scraper `classement.scraper.ts`

**Files:**
- Create: `src/scrapers/ffhandball/classement.scraper.ts`
- Create: `tests/scrapers/classement.scraper.test.ts`

- [ ] **Step 4.1 : Tests (failing)**

```ts
// tests/scrapers/classement.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClassement } from "@/scrapers/ffhandball/classement.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/classements/";
const EXT_POULE_ID = "168256";

describe("parseClassement", () => {
  it("extracts 14 lignes from LBE fixture", () => {
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(14);

    // Position 1 doit exister et être valide
    const premier = r!.find((c) => c.position === 1);
    expect(premier).toBeDefined();
    expect(premier!.ext_equipe_id).toMatch(/^\d+$/);
    expect(premier!.points).toBeGreaterThan(0);
    expect(premier!.joues).toBeGreaterThan(0);

    // dernieres_rencontres devrait être présent
    expect(premier!.dernieres_rencontres).toBeDefined();
    expect(premier!.dernieres_rencontres).toMatch(/^[-0-9;]+$/);

    // Tous les classements pointent vers la bonne poule
    expect(r!.every((c) => c.ext_poule_id === EXT_POULE_ID)).toBe(true);
  });

  it("resolves equipeId interne → ext_equipe_id via equipe_options", () => {
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    for (const c of r!) {
      expect(c.ext_equipe_id).toMatch(/^\d+$/);
      expect(Number(c.ext_equipe_id)).toBeGreaterThan(100000);
    }
  });

  it("returns null when poule-selector is absent", () => {
    expect(parseClassement("<html></html>", SOURCE_URL, EXT_POULE_ID)).toBeNull();
  });

  it("returns [] when classement component is absent but poule-selector present (compétition sans matchs joués)", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "1000001" }],
        poules: [{ ext_pouleId: EXT_POULE_ID }],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).toEqual([]);
  });

  it("returns [] when classements array is empty", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "1000001" }],
        poules: [{ ext_pouleId: EXT_POULE_ID }],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>
    <smartfire-component name='competitions---classement' attributes='${JSON.stringify(
      { classements: [] },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).toEqual([]);
  });

  it("skips lignes whose equipeId is not in equipe_options", () => {
    const html = `<smartfire-component name='competitions---poule-selector' attributes='${JSON.stringify(
      {
        equipe_options: [{ id: "1", ext_equipeId: "1000001" }],   // only equipe id=1
        poules: [{ ext_pouleId: EXT_POULE_ID }],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>
    <smartfire-component name='competitions---classement' attributes='${JSON.stringify(
      {
        classements: [
          { ext_classementId: "C1", pouleId: "X", equipeId: "1", place: "1", point: "10", joue: "5", gagne: "3", nul: "1", perdu: "1", butPlus: "100", butMoins: "80" },
          { ext_classementId: "C2", pouleId: "X", equipeId: "GHOST", place: "2", point: "8", joue: "5", gagne: "2", nul: "2", perdu: "1", butPlus: "90", butMoins: "85" },
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(1);
    expect(r!.length > 0 && r![0]!.ext_classement_id).toBe("C1");
  });
});
```

- [ ] **Step 4.2 : Run failing**

```bash
npx vitest run tests/scrapers/classement.scraper.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4.3 : Implémenter `classement.scraper.ts`**

```ts
// src/scrapers/ffhandball/classement.scraper.ts
import * as cheerio from "cheerio";
import { rawClassementPayloadSchema, type RawClassementPayload } from "@/schemas/classement.schema.js";

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

export function parseClassement(
  html: string,
  sourceUrl: string,
  extPouleId: string,
): RawClassementPayload[] | null {
  const $ = cheerio.load(html);

  // 1. poule-selector → index equipe_options
  const pouleSelector = loadAttributes($, "competitions---poule-selector") as
    | { equipe_options?: Array<{ id?: unknown; ext_equipeId?: unknown }> }
    | null;
  if (!pouleSelector) return null;

  const equipeIdIndex = new Map<string, string>();
  for (const opt of pouleSelector.equipe_options ?? []) {
    const id = typeof opt.id === "string" ? opt.id : null;
    const extId = typeof opt.ext_equipeId === "string" ? opt.ext_equipeId : null;
    if (id && extId) equipeIdIndex.set(id, extId);
  }

  // 2. classement component
  const classementData = loadAttributes($, "competitions---classement") as
    | { classements?: Array<Record<string, unknown>> }
    | null;
  if (!classementData?.classements) return [];

  const result: RawClassementPayload[] = [];
  for (const c of classementData.classements) {
    const equipeIdInternal = typeof c.equipeId === "string" ? c.equipeId : null;
    if (!equipeIdInternal) continue;

    const extEquipeId = equipeIdIndex.get(equipeIdInternal);
    if (!extEquipeId) continue;

    const candidate = {
      ext_classement_id: c.ext_classementId,
      ext_poule_id: extPouleId,
      ext_equipe_id: extEquipeId,
      position: c.place,
      points: c.point,
      joues: c.joue,
      gagnes: c.gagne,
      nuls: c.nul,
      perdus: c.perdu,
      buts_pour: c.butPlus,
      buts_contre: c.butMoins,
      dernieres_rencontres: typeof c.dernieresRencontres === "string" ? c.dernieresRencontres : undefined,
      source_url: sourceUrl,
    };

    const parsed = rawClassementPayloadSchema.safeParse(candidate);
    if (parsed.success) result.push(parsed.data);
  }

  return result;
}
```

- [ ] **Step 4.4 : Run tests passing**

```bash
npx vitest run tests/scrapers/classement.scraper.test.ts
```

Expected: 6 passed.

- [ ] **Step 4.5 : Commit**

```bash
git add src/scrapers/ffhandball/classement.scraper.ts tests/scrapers/classement.scraper.test.ts
git commit -m "$(cat <<'EOF'
feat: scraper classement (parse table classement par poule)

T4 : parseClassement(html, sourceUrl, extPouleId) extrait les
classements depuis competitions---classement. Réutilise le pattern
d'index equipe_options pour résoudre equipeId interne → ext_equipe_id.
Retourne null si poule-selector absent, [] si classement vide.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLI scrape `--entity=classements`

**Files:**
- Modify: `src/cli/scrape.ts`

- [ ] **Step 5.1 : Ajouter handler `scrapeClassements`**

Imports en tête (compléter les existants) :

```ts
import { parseClassement } from "@/scrapers/ffhandball/classement.scraper.js";
```

Handler à ajouter avant `main()` (s'inspirer de `scrapeMatchs` qui a un pattern similaire) :

```ts
async function scrapeClassements(
  saison: string,
  opts: {
    level?: "national" | "regional" | "departemental";
    limit?: number;
  },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "classements",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting classements scrape");

  try {
    const poulesRes = await query<{
      ext_poule_id: string;
      ext_competition_id: string;
      niveau: string;
      detail_url: string;
    }>(
      `SELECT po.id_ffhb AS ext_poule_id,
              c.id_ffhb  AS ext_competition_id,
              c.niveau,
              c.detail_url
         FROM core.poules po
         JOIN core.phases ph       ON ph.id = po.phase_id
         JOIN core.competitions c  ON c.id = ph.competition_id
        WHERE po.saison_code = $1
          AND ($2::text IS NULL OR c.niveau = $2)
          AND c.detail_url IS NOT NULL
        ORDER BY c.niveau, c.id_ffhb, po.id_ffhb`,
      [saison, opts.level ?? null],
    );

    let poules = poulesRes.rows;
    if (opts.limit !== undefined) poules = poules.slice(0, opts.limit);
    logger.info({ count: poules.length }, "poules to process");

    let totalInserted = 0;
    let pouleSkipped = 0;
    let pouleVide = 0;

    for (const po of poules) {
      const url = `${po.detail_url}poule-${po.ext_poule_id}/classements/`;
      const res = await fetchHtml(url);
      await run.incrementPages(1);
      if (res.status >= 400) {
        logger.warn({ url, status: res.status }, "classement page failed");
        pouleSkipped++;
        continue;
      }
      const parsed = parseClassement(res.body, url, po.ext_poule_id);
      if (parsed === null) {
        logger.warn({ url }, "parseClassement returned null");
        pouleSkipped++;
        continue;
      }
      if (parsed.length === 0) {
        pouleVide++;
        continue;
      }
      for (const c of parsed) {
        await insertRaw("classements", {
          scrape_run_id: run.id,
          source_url: c.source_url,
          source_site: "ffhandball.fr",
          natural_key: c.ext_classement_id,
          payload: c,
          saison,
          http_status: res.status,
        });
        totalInserted++;
      }
    }

    logger.info(
      { totalInserted, pouleSkipped, pouleVide, totalPoules: poules.length },
      "classements scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "classements scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}
```

Dispatch dans `main()` :

```ts
  } else if (args.entity === "classements") {
    await scrapeClassements(args.saison, {
      level: args.level as "national" | "regional" | "departemental" | undefined,
      limit: args.limit,
    });
```

- [ ] **Step 5.2 : Smoke test**

Pré-requis : `core.poules` doit être peuplée (sinon `--limit=2 --level=national` ne trouvera rien). Si vide :

```bash
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=3
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
npm run etl -- --entity=equipes      --saison=2025-2026
```

Puis :

```bash
npm run scrape -- --entity=classements --saison=2025-2026 --level=national --limit=2
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*) FROM raw.classements WHERE saison='2025-2026';"
```

Expected : ≥10 lignes (typiquement 14 par poule LBE × 2 poules).

- [ ] **Step 5.3 : Commit**

```bash
git add src/cli/scrape.ts
git commit -m "$(cat <<'EOF'
feat(cli): scrape --entity=classements

T5 : nouveau handler scrapeClassements. Pattern identique à
scrapeMatchs (lit core.poules JOIN phases JOIN competitions pour
les URLs). 1 fetch par poule (pas de --journees=all). Insère
raw.classements avec natural_key = ext_classement_id.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: ETL classements (double FK)

**Files:**
- Create: `src/etl/classements.etl.ts`
- Create: `tests/etl/classements.etl.test.ts`

- [ ] **Step 6.1 : Tests (failing)**

```ts
// tests/etl/classements.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runClassementsEtl } from "@/etl/classements.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extPouleId: string, extEquipeId: string): Promise<{
  poule_id: number; equipe_id: number;
}> {
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
  return { poule_id: poule.rows[0]!.id, equipe_id: equipe.rows[0]!.id };
}

async function insertRawClassement(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','classements',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.classements (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runClassementsEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.classements`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='classements'`);
    await query(`TRUNCATE core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts classement with both FKs resolved", async () => {
    const { poule_id, equipe_id } = await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1",
        ext_poule_id: "PO1",
        ext_equipe_id: "EQ1",
        position: 1,
        points: 73,
        joues: 25,
        gagnes: 24,
        nuls: 0,
        perdus: 1,
        buts_pour: 849,
        buts_contre: 603,
        dernieres_rencontres: "-1;1;1;1;1",
        source_url: "https://x/",
      },
      "C1",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);

    const row = await query<{
      poule_id: number; equipe_id: number; position: number; points: number;
      joues: number; buts_pour: number; difference: number;
      id_ffhb: string | null; dernieres_rencontres: string | null;
    }>(`SELECT poule_id, equipe_id, position, points, joues, buts_pour, difference,
                  id_ffhb, dernieres_rencontres
        FROM core.classements WHERE id_ffhb = 'C1'`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.poule_id).toBe(poule_id);
    expect(row.rows[0]!.equipe_id).toBe(equipe_id);
    expect(row.rows[0]!.position).toBe(1);
    expect(row.rows[0]!.points).toBe(73);
    expect(row.rows[0]!.difference).toBe(246); // GENERATED 849 - 603
    expect(row.rows[0]!.id_ffhb).toBe("C1");
    expect(row.rows[0]!.dernieres_rencontres).toBe("-1;1;1;1;1");
  });

  it("warns and skips when poule FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C2",
        ext_poule_id: "GHOST_POULE",
        ext_equipe_id: "EQ1",
        position: 1, points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
        buts_pour: 0, buts_contre: 0,
        source_url: "https://x/",
      },
      "C2",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips when equipe FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C3",
        ext_poule_id: "PO1",
        ext_equipe_id: "GHOST_EQUIPE",
        position: 1, points: 0, joues: 0, gagnes: 0, nuls: 0, perdus: 0,
        buts_pour: 0, buts_contre: 0,
        source_url: "https://x/",
      },
      "C3",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("rejects invalid payload (Zod fail)", async () => {
    await insertRawClassement({ junk: true } as object, "BAD");
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run → 1 ligne par PK composite)", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1",
        ext_poule_id: "PO1",
        ext_equipe_id: "EQ1",
        position: 1, points: 73, joues: 25, gagnes: 24, nuls: 0, perdus: 1,
        buts_pour: 849, buts_contre: 603,
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    await runClassementsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.classements`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  it("updates stats and capture_date on re-run when classement changes", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 5, points: 10, joues: 5, gagnes: 3, nuls: 1, perdus: 1,
        buts_pour: 100, buts_contre: 80,
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    const before = await query<{ position: number; points: number; capture_date: Date }>(
      `SELECT position, points, capture_date FROM core.classements WHERE id_ffhb='C1'`,
    );

    await new Promise((r) => setTimeout(r, 50));

    // Nouvelle journée : meilleur classement
    await insertRawClassement(
      {
        ext_classement_id: "C1", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 2, points: 13, joues: 6, gagnes: 4, nuls: 1, perdus: 1,
        buts_pour: 130, buts_contre: 100,
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    const after = await query<{ position: number; points: number; capture_date: Date }>(
      `SELECT position, points, capture_date FROM core.classements WHERE id_ffhb='C1'`,
    );
    expect(after.rows[0]!.position).toBe(2);
    expect(after.rows[0]!.points).toBe(13);
    expect(after.rows[0]!.capture_date.getTime()).toBeGreaterThan(before.rows[0]!.capture_date.getTime());
  });

  it("inserts multiple classements for the same poule (full ranking)", async () => {
    const { poule_id } = await seedHierarchy("PO1", "EQ1");
    // Seed a 2nd equipe
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ('EQ2', 'E2', $1)
       ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
      [SAISON],
    );
    await insertRawClassement(
      {
        ext_classement_id: "CA", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 1, points: 10, joues: 5, gagnes: 3, nuls: 1, perdus: 1,
        buts_pour: 100, buts_contre: 80,
        source_url: "https://x/",
      },
      "CA",
    );
    await insertRawClassement(
      {
        ext_classement_id: "CB", ext_poule_id: "PO1", ext_equipe_id: "EQ2",
        position: 2, points: 8, joues: 5, gagnes: 2, nuls: 2, perdus: 1,
        buts_pour: 90, buts_contre: 85,
        source_url: "https://x/",
      },
      "CB",
    );
    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(2);
    const all = await query<{ count: string }>(
      `SELECT count(*) FROM core.classements WHERE poule_id = $1`,
      [poule_id],
    );
    expect(Number(all.rows[0]!.count)).toBe(2);
  });

  it("stores dernieres_rencontres as raw string", async () => {
    await seedHierarchy("PO1", "EQ1");
    await insertRawClassement(
      {
        ext_classement_id: "C1", ext_poule_id: "PO1", ext_equipe_id: "EQ1",
        position: 1, points: 73, joues: 25, gagnes: 24, nuls: 0, perdus: 1,
        buts_pour: 849, buts_contre: 603,
        dernieres_rencontres: "-1;1;0;1;1",
        source_url: "https://x/",
      },
      "C1",
    );
    await runClassementsEtl(SAISON);
    const r = await query<{ dernieres_rencontres: string | null }>(
      `SELECT dernieres_rencontres FROM core.classements WHERE id_ffhb='C1'`,
    );
    expect(r.rows[0]!.dernieres_rencontres).toBe("-1;1;0;1;1");
  });

  afterAll(async () => {
    await closePool();
  });
});
```

- [ ] **Step 6.2 : Run failing**

```bash
npx vitest run tests/etl/classements.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 6.3 : Implémenter `classements.etl.ts`**

```ts
// src/etl/classements.etl.ts
import { query } from "@/db/client.js";
import { rawClassementPayloadSchema, type RawClassementPayload } from "@/schemas/classement.schema.js";
import { logger } from "@/lib/logger.js";

interface RawClassementRow {
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

async function resolvePouleId(idFfhb: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.poules WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

async function resolveEquipeId(idFfhb: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.equipes WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

export async function runClassementsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('classements', $1) RETURNING id`,
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
    const rawRows = await query<RawClassementRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.classements
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawClassementPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'classements',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawClassementPayload = parsed.data;

      const poule_id = await resolvePouleId(p.ext_poule_id, saison);
      if (poule_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'classements',$2,$3)`,
          [etl_run_id, p.ext_classement_id, `poule ${p.ext_poule_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }
      const equipe_id = await resolveEquipeId(p.ext_equipe_id, saison);
      if (equipe_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'classements',$2,$3)`,
          [etl_run_id, p.ext_classement_id, `equipe ${p.ext_equipe_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const upsert = await query<{ inserted: boolean }>(
        `INSERT INTO core.classements (
           poule_id, equipe_id, position, points, joues, gagnes, nuls, perdus,
           buts_pour, buts_contre, id_ffhb, dernieres_rencontres, capture_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (poule_id, equipe_id) DO UPDATE
         SET position             = EXCLUDED.position,
             points               = EXCLUDED.points,
             joues                = EXCLUDED.joues,
             gagnes               = EXCLUDED.gagnes,
             nuls                 = EXCLUDED.nuls,
             perdus               = EXCLUDED.perdus,
             buts_pour            = EXCLUDED.buts_pour,
             buts_contre          = EXCLUDED.buts_contre,
             id_ffhb              = COALESCE(EXCLUDED.id_ffhb, core.classements.id_ffhb),
             dernieres_rencontres = COALESCE(EXCLUDED.dernieres_rencontres, core.classements.dernieres_rencontres),
             capture_date         = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          poule_id, equipe_id,
          p.position, p.points, p.joues, p.gagnes, p.nuls, p.perdus,
          p.buts_pour, p.buts_contre,
          p.ext_classement_id,
          p.dernieres_rencontres ?? null,
        ],
      );

      if (upsert.rows[0]!.inserted) report.rows_inserted++;
      else report.rows_updated++;
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'success',
             rows_read = $2, rows_validated = $3, rows_rejected = $4,
             rows_inserted = $5, rows_updated = $6, rows_noop = $7, warnings_count = $8
         WHERE id = $1`,
      [
        etl_run_id,
        report.rows_read, report.rows_validated, report.rows_rejected,
        report.rows_inserted, report.rows_updated, report.rows_noop, report.warnings_count,
      ],
    );

    logger.info(report, "classements ETL done");
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
npx vitest run tests/etl/classements.etl.test.ts
```

Expected: 8 passed.

- [ ] **Step 6.5 : Commit**

```bash
git add src/etl/classements.etl.ts tests/etl/classements.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL classements (double FK + UPSERT par PK composite)

T6 : raw.classements → core.classements. Résolution FK poule + équipe
avec warning + skip. UPSERT par PK composite (poule_id, equipe_id),
capture_date = now() à chaque run pour traquer la fraîcheur du snapshot.
id_ffhb et dernieres_rencontres propagés via COALESCE.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CLI etl dispatch + ajout dans pipeline

**Files:**
- Modify: `src/cli/etl.ts`

- [ ] **Step 7.1 : Ajouter import + branche**

```ts
// Import en tête
import { runClassementsEtl } from "@/etl/classements.etl.js";

// Dans main(), après match_officiels :
} else if (args.entity === "classements") {
  await runClassementsEtl(args.saison);
```

- [ ] **Step 7.2 : Smoke test fin de chaîne**

```bash
# Pré-requis : raw.classements peuplée (T5 smoke test)
npm run etl -- --entity=classements --saison=2025-2026

docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'classements' AS t, count(*) FROM core.classements
   UNION ALL SELECT 'avec_dernieres', count(dernieres_rencontres) FROM core.classements
   UNION ALL SELECT 'warnings', count(*) FROM core.etl_warnings WHERE entity='classements';"
```

Attendu : count > 0 (typiquement ~14-28 lignes sur 2 poules LBE en smoke), warnings = 0 si les équipes sont bien en core.

- [ ] **Step 7.3 : Commit**

```bash
git add src/cli/etl.ts
git commit -m "$(cat <<'EOF'
feat(cli): etl --entity=classements

T7 : dispatch runClassementsEtl. Ordre complet désormais :
... → matchs → arbitres → match_officiels → classements.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Test intégration end-to-end

**Files:**
- Create: `tests/integration/classements-end-to-end.test.ts`

- [ ] **Step 8.1 : Tests (failing)**

```ts
// tests/integration/classements-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseClassement } from "@/scrapers/ffhandball/classement.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runClassementsEtl } from "@/etl/classements.etl.js";

const SAISON = "2025-2026";
const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/classements/";
const EXT_POULE_ID = "168256";

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

async function seedAllEquipes(classements: Array<{ ext_equipe_id: string }>): Promise<void> {
  const ids = new Set<string>();
  for (const c of classements) ids.add(c.ext_equipe_id);
  for (const id of ids) {
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ($1, 'Equipe', $2)
       ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
      [id, SAISON],
    );
  }
}

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','classements',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("classements end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.classements`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='classements'`);
    await query(`TRUNCATE core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();

    // Seed competition + phase + poule (mais pas équipes — seedées dynamiquement)
    const comp = await query<{ id: number }>(
      `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
       VALUES ('28227', 'LBE', 'national', $1) RETURNING id`,
      [SAISON],
    );
    const phase = await query<{ id: number }>(
      `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
       VALUES ('PH1', $1, 'P', $2) RETURNING id`,
      [comp.rows[0]!.id, SAISON],
    );
    await query(
      `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
       VALUES ($1, $2, 'POULE UNIQUE', $3)`,
      [EXT_POULE_ID, phase.rows[0]!.id, SAISON],
    );
  });

  it("parses LBE fixture → 14 lignes core.classements with FKs resolved", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(14);

    await seedAllEquipes(r!);

    for (const c of r!) {
      await insertRaw("classements", {
        scrape_run_id: run_id,
        source_url: c.source_url,
        source_site: "ffhandball.fr",
        natural_key: c.ext_classement_id,
        payload: c,
        saison: SAISON,
        http_status: 200,
      });
    }

    const report = await runClassementsEtl(SAISON);
    expect(report.rows_inserted).toBe(14);
    expect(report.warnings_count).toBe(0);

    const counts = await query<{ count: string }>(
      `SELECT count(*) FROM core.classements`,
    );
    expect(Number(counts.rows[0]!.count)).toBe(14);

    // Vérifier que la position 1 a le plus de points
    const first = await query<{ points: number }>(
      `SELECT points FROM core.classements WHERE position = 1`,
    );
    const last = await query<{ points: number }>(
      `SELECT points FROM core.classements WHERE position = 14`,
    );
    expect(first.rows[0]!.points).toBeGreaterThan(last.rows[0]!.points);
  });

  it("is idempotent (re-run ETL = same count, capture_date bumps)", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-classement-lbe.html");
    const r = parseClassement(html, SOURCE_URL, EXT_POULE_ID)!;
    await seedAllEquipes(r);
    for (const c of r) {
      await insertRaw("classements", {
        scrape_run_id: run_id, source_url: c.source_url, source_site: "ffhandball.fr",
        natural_key: c.ext_classement_id, payload: c, saison: SAISON, http_status: 200,
      });
    }
    await runClassementsEtl(SAISON);

    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.classements`)).rows[0]!.count;
    const beforeDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.classements WHERE position = 1`)).rows[0]!.capture_date;

    await new Promise((r) => setTimeout(r, 50));
    await runClassementsEtl(SAISON);

    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.classements`)).rows[0]!.count;
    const afterDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.classements WHERE position = 1`)).rows[0]!.capture_date;

    expect(after).toBe(before);
    expect(afterDate.getTime()).toBeGreaterThan(beforeDate.getTime());
  });
});
```

⚠️ Pas de `afterAll(closePool)` ici (T6/classements.etl.test.ts l'a déjà).

- [ ] **Step 8.2 : Run + suite séquentielle**

```bash
npx vitest run tests/integration/classements-end-to-end.test.ts
# Expected : 2 PASS

npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
# Expected : 146 précédents + 5 (T2) + 6 (T4) + 8 (T6) + 2 (T8) = 167 tests pass
```

- [ ] **Step 8.3 : Commit**

```bash
git add tests/integration/classements-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test: intégration end-to-end classements

T8 : parse fixture LBE → 14 lignes core.classements avec FKs résolues,
positions cohérentes (point[1] > point[14]). Idempotence : re-run ETL
ne crée pas de doublons mais bump capture_date.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Runbook + smoke test final

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 9.1 : Ajouter section "Scraper les classements"**

Ajouter à la fin de `docs/runbook.md` :

```markdown
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
```

- [ ] **Step 9.2 : Smoke test final pipeline complet**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'classements' AS t, count(*) FROM core.classements
   UNION ALL SELECT 'capture_date_max', extract(epoch from max(capture_date))::text::bigint FROM core.classements;"
```

- [ ] **Step 9.3 : Commit**

```bash
git add docs/runbook.md
git commit -m "$(cat <<'EOF'
docs(runbook): section classements (snapshot par poule)

T9 : commandes scrape (3 modes : limit, level, full), ETL avec ordre
obligatoire global étendu, SQL de suivi (counts, poules sans classement,
top buteurs par poule, fraîcheur snapshots, warnings), notes
opérationnelles (re-run quotidien recommandé via cron pour fraîcheur).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **F.1 : Suite séquentielle complète**

```bash
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
```

Expected : ~167 tests pass.

- [ ] **F.2 : Typecheck + lint**

```bash
npm run typecheck
npm run lint 2>/dev/null || echo "no lint script"
```

- [ ] **F.3 : Merge sur master**

```bash
git checkout master
git merge --no-ff feat/classements -m "Merge feat/classements: snapshot classement par poule (position, points, J/G/N/P, forme récente)"
git push origin master
```
