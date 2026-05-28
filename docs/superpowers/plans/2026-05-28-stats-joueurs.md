# Stats joueurs (national) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Créer `core.stats_joueurs` (nouvelle table) et alimenter les stats publiques nationales depuis `competitions---stats-joueurs`. Filtrage `niveau='national'` en amont, détection soft-404 pour les autres niveaux.

**Architecture:** Scraper indépendant (pattern identique à `classement.scraper.ts` mais SANS index `equipe_options` — la résolution équipe se fait côté ETL via match exact `nom`). ETL avec double FK (poule strict, équipe best-effort).

**Tech Stack:** TypeScript 5.7, Cheerio, Zod, Postgres 16, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-stats-joueurs-design.md`

**Pré-requis :** branche `feat/stats-joueurs` créée. `core.poules` et `core.equipes` (national au moins) doivent être peuplées pour les smoke tests.

---

### Task 1: Fixture LBE stats joueurs

**Files:**
- Create: `tests/fixtures/ffhandball-poule-stats-lbe.html`

- [ ] **Step 1.1 : Fetcher la page stats LBE**

```bash
UA="Mozilla/5.0 ffhandball-pipeline (loric@example.com)"
curl -s -A "$UA" \
  "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/statistiques/" \
  -o tests/fixtures/ffhandball-poule-stats-lbe.html
```

- [ ] **Step 1.2 : Vérifier le contenu**

```bash
grep -c "competitions---stats-joueurs" tests/fixtures/ffhandball-poule-stats-lbe.html

node -e "
const fs = require('fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('tests/fixtures/ffhandball-poule-stats-lbe.html', 'utf8');
const \$ = cheerio.load(html);
const el = \$('smartfire-component[name=\"competitions---stats-joueurs\"]').first();
const data = JSON.parse(el.attr('attributes'));
console.log('Nombre rowsData:', data.rowsData?.length);
console.log('Meilleur buteur:', JSON.stringify(data.rowsData?.[0], null, 2));
"
```

Expected : 287 lignes, top scoreur LBE = ANTONISSEN NELE (195 buts).

- [ ] **Step 1.3 : Commit**

```bash
git add tests/fixtures/ffhandball-poule-stats-lbe.html
git commit -m "$(cat <<'EOF'
feat: fixture stats joueurs LBE poule 168256

T1 : capture HTML pour TDD scraper stats-joueurs (287 joueurs nationaux).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Schéma Zod stats-joueur

**Files:**
- Create: `src/schemas/stats-joueur.schema.ts`
- Create: `tests/schemas/stats-joueur.schema.test.ts`

- [ ] **Step 2.1 : Tests (failing)**

```ts
// tests/schemas/stats-joueur.schema.test.ts
import { describe, it, expect } from "vitest";
import { rawStatsJoueurPayloadSchema } from "@/schemas/stats-joueur.schema.js";

describe("rawStatsJoueurPayloadSchema", () => {
  it("accepts a complete payload with strings (source format)", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "168256",
      individu_id: "3098815",
      nom: "ANTONISSEN",
      prenom: "NELE",
      equipe_libelle: "HANDBALL PLAN DE CUQUES",
      match_count: "25",
      total_buts: "195",
      total_arrets: "0",
      source_url: "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/statistiques/",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.match_count).toBe(25);
      expect(r.data.total_buts).toBe(195);
      expect(r.data.total_arrets).toBe(0);
    }
  });

  it("accepts payload with numbers directly", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "I",
      nom: "N",
      prenom: "P",
      equipe_libelle: "E",
      match_count: 5,
      total_buts: 30,
      total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty individu_id", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "",
      nom: "N", prenom: "P", equipe_libelle: "E",
      match_count: 0, total_buts: 0, total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty equipe_libelle", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "I",
      nom: "N", prenom: "P", equipe_libelle: "",
      match_count: 0, total_buts: 0, total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects when match_count is malformed (non-numeric)", () => {
    const r = rawStatsJoueurPayloadSchema.safeParse({
      ext_poule_id: "P",
      individu_id: "I",
      nom: "N", prenom: "P", equipe_libelle: "E",
      match_count: "abc",
      total_buts: 0, total_arrets: 0,
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2.2 : Run failing**

```bash
npx vitest run tests/schemas/stats-joueur.schema.test.ts
```

- [ ] **Step 2.3 : Implémenter `stats-joueur.schema.ts`**

```ts
// src/schemas/stats-joueur.schema.ts
import { z } from "zod";

const intFromStringOrNumber = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  },
  z.number().int().nonnegative(),
);

export const rawStatsJoueurPayloadSchema = z.object({
  ext_poule_id: z.string().min(1),
  individu_id: z.string().min(1),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  equipe_libelle: z.string().min(1),
  match_count: intFromStringOrNumber,
  total_buts: intFromStringOrNumber,
  total_arrets: intFromStringOrNumber,
  source_url: z.string().url(),
});
export type RawStatsJoueurPayload = z.infer<typeof rawStatsJoueurPayloadSchema>;
```

- [ ] **Step 2.4 : Run passing**

```bash
npx vitest run tests/schemas/stats-joueur.schema.test.ts
```

Expected : 5 passed.

- [ ] **Step 2.5 : Commit**

```bash
git add src/schemas/stats-joueur.schema.ts tests/schemas/stats-joueur.schema.test.ts
git commit -m "$(cat <<'EOF'
feat: schéma Zod stats-joueur

T2 : payload Zod-validé avec preprocess intFromStringOrNumber (coercion
strings source). Tous les champs requis (pas d'optionnels). Helper
nonnegative pour scores positifs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration 0013 (CREATE TABLE core.stats_joueurs)

**Files:**
- Create: `db/migrations/0013_stats_joueurs.sql`

- [ ] **Step 3.1 : Pré-vérification**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt core.stats_joueurs"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt raw.stats_joueurs"
```

Expected : aucune des 2 tables n'existe encore.

- [ ] **Step 3.2 : Écrire la migration**

```sql
-- db/migrations/0013_stats_joueurs.sql

-- 1. Raw table
SELECT raw._create_capture_table('stats_joueurs');

-- 2. Core table (nouvelle)
CREATE TABLE IF NOT EXISTS core.stats_joueurs (
  id             bigserial PRIMARY KEY,
  poule_id       bigint NOT NULL REFERENCES core.poules(id) ON DELETE CASCADE,
  individu_id    text NOT NULL,
  nom            text NOT NULL,
  prenom         text NOT NULL,
  equipe_id      bigint REFERENCES core.equipes(id),
  equipe_libelle text NOT NULL,
  match_count    integer NOT NULL DEFAULT 0,
  total_buts     integer NOT NULL DEFAULT 0,
  total_arrets   integer NOT NULL DEFAULT 0,
  saison_code    text NOT NULL REFERENCES core.saisons(saison_code),
  capture_date   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_stats_joueurs_poule_individu UNIQUE (poule_id, individu_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_joueurs_poule       ON core.stats_joueurs (poule_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_equipe      ON core.stats_joueurs (equipe_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_individu    ON core.stats_joueurs (individu_id);
CREATE INDEX IF NOT EXISTS idx_stats_joueurs_total_buts  ON core.stats_joueurs (total_buts DESC) WHERE total_buts > 0;
```

- [ ] **Step 3.3 : Lancer + vérifier**

```bash
npm run db:migrate
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.stats_joueurs"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d raw.stats_joueurs"
```

Expected :
- `core.stats_joueurs` créée avec toutes les colonnes
- `raw.stats_joueurs` créée via `_create_capture_table` (natural_key, payload, etc.)
- 4 indexes core listés
- UNIQUE `uq_stats_joueurs_poule_individu`

- [ ] **Step 3.4 : Commit**

```bash
git add db/migrations/0013_stats_joueurs.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 0013 — nouvelle table core.stats_joueurs

T3 : CREATE TABLE core.stats_joueurs (poule_id FK, individu_id, nom,
prenom, equipe_id FK nullable, equipe_libelle, match_count, total_buts,
total_arrets, saison_code FK, capture_date). PK composite
(poule_id, individu_id). 4 indexes (poule, equipe, individu, top buts).

raw.stats_joueurs créée via _create_capture_table existant.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Scraper `stats-joueurs.scraper.ts`

**Files:**
- Create: `src/scrapers/ffhandball/stats-joueurs.scraper.ts`
- Create: `tests/scrapers/stats-joueurs.scraper.test.ts`

- [ ] **Step 4.1 : Tests (failing)**

```ts
// tests/scrapers/stats-joueurs.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseStatsJoueurs } from "@/scrapers/ffhandball/stats-joueurs.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/statistiques/";
const EXT_POULE_ID = "168256";

describe("parseStatsJoueurs", () => {
  it("extracts 287 stats from LBE fixture", () => {
    const html = fixture("ffhandball-poule-stats-lbe.html");
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    expect(r.length).toBe(287);

    // Meilleur buteur ANTONISSEN
    const top = r.find((s) => s.nom === "ANTONISSEN");
    expect(top).toBeDefined();
    expect(top!.prenom).toBe("NELE");
    expect(top!.total_buts).toBe(195);
    expect(top!.match_count).toBe(25);
    expect(top!.equipe_libelle).toBe("HANDBALL PLAN DE CUQUES");
    expect(top!.ext_poule_id).toBe(EXT_POULE_ID);

    // Tous les ext_poule_id pointent vers la bonne poule
    expect(r.every((s) => s.ext_poule_id === EXT_POULE_ID)).toBe(true);

    // Coercion strings → numbers vérifiée
    for (const s of r) {
      expect(typeof s.match_count).toBe("number");
      expect(typeof s.total_buts).toBe("number");
      expect(typeof s.total_arrets).toBe("number");
    }
  });

  it("returns [] on soft-404 (is404=true in page-header)", () => {
    const html = `<smartfire-component name='competitions---page-header' attributes='${JSON.stringify(
      { is404: true, title: "Page not found - FFHandball" },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    expect(parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID)).toEqual([]);
  });

  it("returns [] when stats-joueurs component is absent", () => {
    const html = `<smartfire-component name='competitions---page-header' attributes='${JSON.stringify(
      { is404: false },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    expect(parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID)).toEqual([]);
  });

  it("returns [] when rowsData is empty", () => {
    const html = `<smartfire-component name='competitions---stats-joueurs' attributes='${JSON.stringify(
      { rowsData: [] },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    expect(parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID)).toEqual([]);
  });

  it("skips lignes where required fields are missing", () => {
    const html = `<smartfire-component name='competitions---stats-joueurs' attributes='${JSON.stringify(
      {
        rowsData: [
          { individuId: "I1", nom: "OK", prenom: "User", equipeLibelle: "E", matchCount: "5", totalButs: "10", totalArrets: "0" },
          { individuId: "I2", nom: "", prenom: "Missing", equipeLibelle: "E", matchCount: "1", totalButs: "0", totalArrets: "0" }, // nom vide
        ],
      },
    ).replace(/'/g, "&apos;")}'></smartfire-component>`;
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    expect(r.length).toBe(1);
    expect(r[0]!.individu_id).toBe("I1");
  });
});
```

- [ ] **Step 4.2 : Run failing**

```bash
npx vitest run tests/scrapers/stats-joueurs.scraper.test.ts
```

- [ ] **Step 4.3 : Implémenter `stats-joueurs.scraper.ts`**

```ts
// src/scrapers/ffhandball/stats-joueurs.scraper.ts
import * as cheerio from "cheerio";
import { rawStatsJoueurPayloadSchema, type RawStatsJoueurPayload } from "@/schemas/stats-joueur.schema.js";

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

export function parseStatsJoueurs(
  html: string,
  sourceUrl: string,
  extPouleId: string,
): RawStatsJoueurPayload[] {
  const $ = cheerio.load(html);

  // 1. Détecter soft-404 via page-header (régional/dép)
  const header = loadAttributes($, "competitions---page-header") as { is404?: boolean } | null;
  if (header?.is404 === true) return [];

  // 2. Parser stats-joueurs
  const data = loadAttributes($, "competitions---stats-joueurs") as
    | { rowsData?: Array<Record<string, unknown>> }
    | null;
  if (!data?.rowsData) return [];

  const result: RawStatsJoueurPayload[] = [];
  for (const row of data.rowsData) {
    const candidate = {
      ext_poule_id: extPouleId,
      individu_id: row.individuId,
      nom: row.nom,
      prenom: row.prenom,
      equipe_libelle: row.equipeLibelle,
      match_count: row.matchCount,
      total_buts: row.totalButs,
      total_arrets: row.totalArrets,
      source_url: sourceUrl,
    };
    const parsed = rawStatsJoueurPayloadSchema.safeParse(candidate);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
```

- [ ] **Step 4.4 : Run tests passing**

```bash
npx vitest run tests/scrapers/stats-joueurs.scraper.test.ts
```

Expected : 5 passed.

- [ ] **Step 4.5 : Commit**

```bash
git add src/scrapers/ffhandball/stats-joueurs.scraper.ts tests/scrapers/stats-joueurs.scraper.test.ts
git commit -m "$(cat <<'EOF'
feat: scraper stats-joueurs (national, soft-404 detection)

T4 : parseStatsJoueurs(html, sourceUrl, extPouleId) extrait depuis
competitions---stats-joueurs.rowsData[]. Détecte les soft-404
(page-header.is404=true) pour skipper proprement les niveaux
régional/départemental. Retourne toujours un tableau (vide ou non),
jamais null.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLI scrape `--entity=stats-joueurs`

**Files:**
- Modify: `src/cli/scrape.ts`

- [ ] **Step 5.1 : Ajouter handler `scrapeStatsJoueurs`**

Imports en tête (compléter) :

```ts
import { parseStatsJoueurs } from "@/scrapers/ffhandball/stats-joueurs.scraper.js";
```

Handler à ajouter avant `main()` :

```ts
async function scrapeStatsJoueurs(
  saison: string,
  opts: { limit?: number },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "stats-joueurs",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting stats-joueurs scrape");

  try {
    // Filtre niveau='national' en amont (gain ~95% des fetches)
    const poulesRes = await query<{
      ext_poule_id: string;
      detail_url: string;
    }>(
      `SELECT po.id_ffhb AS ext_poule_id, c.detail_url
         FROM core.poules po
         JOIN core.phases ph       ON ph.id = po.phase_id
         JOIN core.competitions c  ON c.id = ph.competition_id
        WHERE po.saison_code = $1
          AND c.niveau = 'national'
          AND c.detail_url IS NOT NULL
        ORDER BY c.id_ffhb, po.id_ffhb`,
      [saison],
    );

    let poules = poulesRes.rows;
    if (opts.limit !== undefined) poules = poules.slice(0, opts.limit);
    logger.info({ count: poules.length }, "national poules to process");

    let totalInserted = 0;
    let pouleSansStats = 0;

    for (const po of poules) {
      const url = `${po.detail_url}poule-${po.ext_poule_id}/statistiques/`;
      const res = await fetchHtml(url);
      await run.incrementPages(1);
      if (res.status >= 400) {
        logger.warn({ url, status: res.status }, "stats page failed");
        continue;
      }
      const parsed = parseStatsJoueurs(res.body, url, po.ext_poule_id);
      if (parsed.length === 0) {
        pouleSansStats++;
        continue;
      }
      for (const s of parsed) {
        await insertRaw("stats_joueurs", {
          scrape_run_id: run.id,
          source_url: s.source_url,
          source_site: "ffhandball.fr",
          natural_key: `${s.ext_poule_id}-${s.individu_id}`,
          payload: s,
          saison,
          http_status: res.status,
        });
        totalInserted++;
      }
    }
    logger.info(
      { totalInserted, pouleSansStats, totalPoules: poules.length },
      "stats-joueurs scrape done",
    );
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "stats-joueurs scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}
```

Dispatch dans `main()` :

```ts
  } else if (args.entity === "stats-joueurs") {
    await scrapeStatsJoueurs(args.saison, { limit: args.limit });
```

- [ ] **Step 5.2 : Smoke test**

Pré-requis : `core.poules` peuplée pour des compétitions **nationales** (sinon 0 poules à traiter).

```bash
# Si vide, scrape minimal compétitions nationales :
npm run scrape -- --entity=competitions --saison=2025-2026 --level=national --limit=3
npm run etl -- --entity=competitions --saison=2025-2026
npm run etl -- --entity=phases       --saison=2025-2026
npm run etl -- --entity=poules       --saison=2025-2026
npm run etl -- --entity=equipes      --saison=2025-2026
```

Puis :

```bash
npm run scrape -- --entity=stats-joueurs --saison=2025-2026 --limit=2

docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*) FROM raw.stats_joueurs WHERE saison='2025-2026';"
```

Expected : ~500-600 lignes (typiquement ~287 par poule LBE × 2 poules limitées).

- [ ] **Step 5.3 : Commit**

```bash
git add src/cli/scrape.ts
git commit -m "$(cat <<'EOF'
feat(cli): scrape --entity=stats-joueurs

T5 : handler scrapeStatsJoueurs filtre niveau='national' en amont
(évite ~95%% des fetches inutiles vers régional/dép qui retournent
soft-404). natural_key composite ext_poule_id-individu_id pour
supporter les joueurs multi-poules.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: ETL stats-joueurs (double FK avec match exact)

**Files:**
- Create: `src/etl/stats-joueurs.etl.ts`
- Create: `tests/etl/stats-joueurs.etl.test.ts`

- [ ] **Step 6.1 : Tests (failing)**

```ts
// tests/etl/stats-joueurs.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runStatsJoueursEtl } from "@/etl/stats-joueurs.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extPouleId: string, equipeNom: string): Promise<{
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
     VALUES ('E1', $1, $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [equipeNom, SAISON],
  );
  return { poule_id: poule.rows[0]!.id, equipe_id: equipe.rows[0]!.id };
}

async function insertRawStats(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','stats-joueurs',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.stats_joueurs (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runStatsJoueursEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.stats_joueurs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='stats-joueurs'`);
    await query(`TRUNCATE core.stats_joueurs, core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts stat with both FKs resolved (equipe match exact)", async () => {
    const { poule_id, equipe_id } = await seedHierarchy("PO1", "HANDBALL PLAN DE CUQUES");
    await insertRawStats(
      {
        ext_poule_id: "PO1",
        individu_id: "I1",
        nom: "ANTONISSEN",
        prenom: "NELE",
        equipe_libelle: "HANDBALL PLAN DE CUQUES",
        match_count: 25,
        total_buts: 195,
        total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);

    const row = await query<{
      poule_id: number; equipe_id: number | null;
      individu_id: string; total_buts: number;
      equipe_libelle: string;
    }>(`SELECT poule_id, equipe_id, individu_id, total_buts, equipe_libelle
        FROM core.stats_joueurs`);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.poule_id).toBe(poule_id);
    expect(row.rows[0]!.equipe_id).toBe(equipe_id);
    expect(row.rows[0]!.total_buts).toBe(195);
    expect(row.rows[0]!.equipe_libelle).toBe("HANDBALL PLAN DE CUQUES");
  });

  it("warns and skips when poule FK does not resolve", async () => {
    await seedHierarchy("PO1", "EQUIPE");
    await insertRawStats(
      {
        ext_poule_id: "GHOST_POULE",
        individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQUIPE",
        match_count: 0, total_buts: 0, total_arrets: 0,
        source_url: "https://x/",
      },
      "GHOST_POULE-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("inserts with equipe_id=NULL + warning when equipe_libelle does not match", async () => {
    const { poule_id } = await seedHierarchy("PO1", "EQUIPE_REELLE");
    await insertRawStats(
      {
        ext_poule_id: "PO1",
        individu_id: "I1",
        nom: "N", prenom: "P",
        equipe_libelle: "EQUIPE_INTROUVABLE",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(1);
    const row = await query<{ equipe_id: number | null; equipe_libelle: string }>(
      `SELECT equipe_id, equipe_libelle FROM core.stats_joueurs WHERE poule_id = $1`,
      [poule_id],
    );
    expect(row.rows[0]!.equipe_id).toBeNull();
    expect(row.rows[0]!.equipe_libelle).toBe("EQUIPE_INTROUVABLE");
  });

  it("rejects invalid payload (Zod fail)", async () => {
    await insertRawStats({ junk: true } as object, "BAD");
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run → 1 ligne par PK composite)", async () => {
    await seedHierarchy("PO1", "EQ");
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQ",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await runStatsJoueursEtl(SAISON);
    await runStatsJoueursEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.stats_joueurs`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });

  it("updates stats and capture_date on re-run when values change", async () => {
    await seedHierarchy("PO1", "EQ");
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQ",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await runStatsJoueursEtl(SAISON);
    const before = await query<{ total_buts: number; capture_date: Date }>(
      `SELECT total_buts, capture_date FROM core.stats_joueurs`,
    );

    await new Promise((r) => setTimeout(r, 50));

    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQ",
        match_count: 8, total_buts: 25, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await runStatsJoueursEtl(SAISON);
    const after = await query<{ total_buts: number; capture_date: Date }>(
      `SELECT total_buts, capture_date FROM core.stats_joueurs`,
    );
    expect(after.rows[0]!.total_buts).toBe(25);
    expect(after.rows[0]!.capture_date.getTime()).toBeGreaterThan(before.rows[0]!.capture_date.getTime());
  });

  it("inserts multiple joueurs for same poule (full ranking)", async () => {
    const { poule_id } = await seedHierarchy("PO1", "EQ");
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "A", prenom: "X", equipe_libelle: "EQ",
        match_count: 5, total_buts: 30, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I2",
        nom: "B", prenom: "Y", equipe_libelle: "EQ",
        match_count: 5, total_buts: 25, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I2",
    );
    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(2);
    const all = await query<{ count: string }>(
      `SELECT count(*) FROM core.stats_joueurs WHERE poule_id = $1`,
      [poule_id],
    );
    expect(Number(all.rows[0]!.count)).toBe(2);
  });

  it("equipe match strict scoped by saison (no cross-saison match)", async () => {
    // Une équipe en saison différente avec même nom ne devrait pas matcher
    await query(
      `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
       VALUES ('2024-2025', '2024-07-01', '2025-06-30')
       ON CONFLICT DO NOTHING`,
    );
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ('OLD', 'EQUIPE_X', '2024-2025')`,
    );
    const { poule_id } = await seedHierarchy("PO1", "AUTRE");

    await insertRawStats(
      {
        ext_poule_id: "PO1", individu_id: "I1",
        nom: "N", prenom: "P", equipe_libelle: "EQUIPE_X",
        match_count: 5, total_buts: 10, total_arrets: 0,
        source_url: "https://x/",
      },
      "PO1-I1",
    );
    const report = await runStatsJoueursEtl(SAISON);
    // Match doit échouer car EQUIPE_X est sur saison 2024-2025, pas 2025-2026
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(1);
    const row = await query<{ equipe_id: number | null }>(
      `SELECT equipe_id FROM core.stats_joueurs WHERE poule_id = $1`,
      [poule_id],
    );
    expect(row.rows[0]!.equipe_id).toBeNull();
  });

  afterAll(async () => {
    await closePool();
  });
});
```

- [ ] **Step 6.2 : Run failing**

```bash
npx vitest run tests/etl/stats-joueurs.etl.test.ts
```

- [ ] **Step 6.3 : Implémenter `stats-joueurs.etl.ts`**

```ts
// src/etl/stats-joueurs.etl.ts
import { query } from "@/db/client.js";
import { rawStatsJoueurPayloadSchema, type RawStatsJoueurPayload } from "@/schemas/stats-joueur.schema.js";
import { logger } from "@/lib/logger.js";

interface RawStatsRow {
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

async function resolveEquipeIdByLibelle(libelle: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.equipes WHERE nom = $1 AND saison_code = $2 LIMIT 1`,
    [libelle, saison],
  );
  return r.rows[0]?.id ?? null;
}

export async function runStatsJoueursEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('stats_joueurs', $1) RETURNING id`,
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
    const rawRows = await query<RawStatsRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.stats_joueurs
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawStatsJoueurPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'stats_joueurs',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawStatsJoueurPayload = parsed.data;

      // FK poule strict
      const poule_id = await resolvePouleId(p.ext_poule_id, saison);
      if (poule_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'stats_joueurs',$2,$3)`,
          [etl_run_id, row.natural_key, `poule ${p.ext_poule_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      // FK equipe best-effort (match exact sur nom saison-scopé)
      const equipe_id = await resolveEquipeIdByLibelle(p.equipe_libelle, saison);
      if (equipe_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'stats_joueurs',$2,$3)`,
          [etl_run_id, row.natural_key, `équipe "${p.equipe_libelle}" non résolue`],
        );
        report.warnings_count++;
        // continue : on insère quand même avec equipe_id = NULL
      }

      const upsert = await query<{ inserted: boolean }>(
        `INSERT INTO core.stats_joueurs (
           poule_id, individu_id, nom, prenom, equipe_id, equipe_libelle,
           match_count, total_buts, total_arrets, saison_code, capture_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (poule_id, individu_id) DO UPDATE
         SET nom            = EXCLUDED.nom,
             prenom         = EXCLUDED.prenom,
             equipe_id      = COALESCE(EXCLUDED.equipe_id, core.stats_joueurs.equipe_id),
             equipe_libelle = EXCLUDED.equipe_libelle,
             match_count    = EXCLUDED.match_count,
             total_buts     = EXCLUDED.total_buts,
             total_arrets   = EXCLUDED.total_arrets,
             capture_date   = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          poule_id, p.individu_id, p.nom, p.prenom,
          equipe_id, p.equipe_libelle,
          p.match_count, p.total_buts, p.total_arrets,
          saison,
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

    logger.info(report, "stats_joueurs ETL done");
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
npx vitest run tests/etl/stats-joueurs.etl.test.ts
```

Expected : 8 passed.

- [ ] **Step 6.5 : Commit**

```bash
git add src/etl/stats-joueurs.etl.ts tests/etl/stats-joueurs.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL stats-joueurs (FK poule strict + FK equipe best-effort)

T6 : raw.stats_joueurs → core.stats_joueurs. FK poule strict (warning+skip
si non résolue). FK equipe via match exact nom saison-scopé (insertion
avec equipe_id=NULL + warning si pas de match — on conserve equipe_libelle
brut pour debug et résolution future). UPSERT par PK composite
(poule_id, individu_id), capture_date bumped à chaque run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CLI etl dispatch stats-joueurs

**Files:**
- Modify: `src/cli/etl.ts`

- [ ] **Step 7.1 : Ajouter import + branche**

```ts
import { runStatsJoueursEtl } from "@/etl/stats-joueurs.etl.js";

// Dans main(), après classements :
} else if (args.entity === "stats-joueurs") {
  await runStatsJoueursEtl(args.saison);
```

- [ ] **Step 7.2 : Smoke test**

```bash
# Pré-requis : raw.stats_joueurs peuplée (T5 smoke test)
npm run etl -- --entity=stats-joueurs --saison=2025-2026

docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'stats_joueurs' AS t, count(*) FROM core.stats_joueurs
   UNION ALL SELECT 'equipe_resolu', count(equipe_id) FROM core.stats_joueurs
   UNION ALL SELECT 'top_buteur', max(total_buts) FROM core.stats_joueurs
   UNION ALL SELECT 'warnings', count(*) FROM core.etl_warnings WHERE entity='stats_joueurs';"
```

- [ ] **Step 7.3 : Commit**

```bash
git add src/cli/etl.ts
git commit -m "$(cat <<'EOF'
feat(cli): etl --entity=stats-joueurs

T7 : dispatch runStatsJoueursEtl. Ordre complet désormais :
... → classements → stats-joueurs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Test intégration end-to-end

**Files:**
- Create: `tests/integration/stats-joueurs-end-to-end.test.ts`

- [ ] **Step 8.1 : Tests**

```ts
// tests/integration/stats-joueurs-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseStatsJoueurs } from "@/scrapers/ffhandball/stats-joueurs.scraper.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runStatsJoueursEtl } from "@/etl/stats-joueurs.etl.js";

const SAISON = "2025-2026";
const SOURCE_URL = "https://www.ffhandball.fr/competitions/saison-2025-2026-21/national/ligue-butagaz-energie-2025-26-28227/poule-168256/statistiques/";
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

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','stats-joueurs',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("stats-joueurs end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.stats_joueurs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='stats-joueurs'`);
    await query(`TRUNCATE core.stats_joueurs, core.classements, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();

    // Seed competition + phase + poule + qq équipes connues
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
    // Seed 2 équipes connues (parmi les 14 que la fixture mentionne)
    await query(
      `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
       VALUES ('E1', 'HANDBALL PLAN DE CUQUES', $1),
              ('E2', 'PARIS 92', $1)
       ON CONFLICT (id_ffhb, saison_code) DO NOTHING`,
      [SAISON],
    );
  });

  it("parses LBE fixture → 287 lignes core.stats_joueurs, équipes partiellement résolues", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-stats-lbe.html");
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    expect(r.length).toBe(287);

    for (const s of r) {
      await insertRaw("stats_joueurs", {
        scrape_run_id: run_id, source_url: s.source_url, source_site: "ffhandball.fr",
        natural_key: `${s.ext_poule_id}-${s.individu_id}`,
        payload: s, saison: SAISON, http_status: 200,
      });
    }

    const report = await runStatsJoueursEtl(SAISON);
    expect(report.rows_inserted).toBe(287);
    // Beaucoup de warnings attendus (12 équipes non seeded sur 14)
    expect(report.warnings_count).toBeGreaterThan(0);

    // Vérifier que des équipes connues sont bien résolues
    const resolved = await query<{ count: string }>(
      `SELECT count(*) FROM core.stats_joueurs WHERE equipe_id IS NOT NULL`,
    );
    expect(Number(resolved.rows[0]!.count)).toBeGreaterThan(0);

    // Top buteur ANTONISSEN doit être là
    const top = await query<{ total_buts: number; nom: string }>(
      `SELECT total_buts, nom FROM core.stats_joueurs
       ORDER BY total_buts DESC LIMIT 1`,
    );
    expect(top.rows[0]!.nom).toBe("ANTONISSEN");
    expect(top.rows[0]!.total_buts).toBe(195);
  });

  it("is idempotent (re-run = same count, capture_date bumps)", async () => {
    const run_id = await startRun();
    const html = fixture("ffhandball-poule-stats-lbe.html");
    const r = parseStatsJoueurs(html, SOURCE_URL, EXT_POULE_ID);
    for (const s of r) {
      await insertRaw("stats_joueurs", {
        scrape_run_id: run_id, source_url: s.source_url, source_site: "ffhandball.fr",
        natural_key: `${s.ext_poule_id}-${s.individu_id}`,
        payload: s, saison: SAISON, http_status: 200,
      });
    }
    await runStatsJoueursEtl(SAISON);

    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.stats_joueurs`)).rows[0]!.count;
    const beforeDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.stats_joueurs LIMIT 1`)).rows[0]!.capture_date;

    await new Promise((r) => setTimeout(r, 50));
    await runStatsJoueursEtl(SAISON);

    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.stats_joueurs`)).rows[0]!.count;
    const afterDate = (await query<{ capture_date: Date }>(`SELECT capture_date FROM core.stats_joueurs ORDER BY id LIMIT 1`)).rows[0]!.capture_date;

    expect(after).toBe(before);
    expect(afterDate.getTime()).toBeGreaterThan(beforeDate.getTime());
  });
});
```

⚠️ Ne PAS ajouter `afterAll(closePool)` ici — T6 l'a déjà.

- [ ] **Step 8.2 : Run intégration + suite complète**

```bash
npx vitest run tests/integration/stats-joueurs-end-to-end.test.ts
# Expected : 2 PASS

npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
# Expected : ~167 précédents + 5 (T2) + 5 (T4) + 8 (T6) + 2 (T8) = 187 tests pass
```

- [ ] **Step 8.3 : Commit**

```bash
git add tests/integration/stats-joueurs-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test: intégration end-to-end stats-joueurs

T8 : parse fixture LBE (287 joueurs) → ETL → 287 lignes core.stats_joueurs.
Équipes partiellement résolues (warnings attendus pour les équipes non
seeded). Idempotence + capture_date bumped au re-run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Runbook section stats-joueurs

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 9.1 : Ajouter la section**

Ajouter à la fin de `docs/runbook.md` :

```markdown
## Scraper les stats joueurs (national uniquement)

Alimente `core.stats_joueurs` depuis le composant `competitions---stats-joueurs`.
**Scope : compétitions nationales uniquement.** Les autres niveaux retournent un
soft-404 silencieux (`page-header.is404=true`), détecté et géré proprement par
le scraper.

### Données disponibles publiquement

- `individu_id` (ID FFHB du joueur, anonymisé côté public)
- `nom`, `prenom`
- `match_count`, `total_buts`, `total_arrets`
- `equipe_libelle` (résolu en `equipe_id` via match exact côté ETL, sinon NULL)

**Ce qu'on n'a PAS** : date de naissance, sexe, nationalité, numéro de licence,
poste/position joueur — derrière login GestHand (RGPD).

### Scrape

```bash
# Dev — 3 poules nationales
npm run scrape -- --entity=stats-joueurs --saison=2025-2026 --limit=3

# Run complet national (~50-100 poules nationales, ~2-3 min)
npm run scrape -- --entity=stats-joueurs --saison=2025-2026
```

Pas d'option `--level` — par design seules les compétitions nationales ont des
stats publiques. Le filtre `niveau='national'` est appliqué en amont.

### ETL

```bash
npm run etl -- --entity=stats-joueurs --saison=2025-2026
```

**Ordre obligatoire global** : `competitions → phases → poules → equipes →
engagements → matchs → arbitres → match_officiels → classements → stats-joueurs`.

### Suivre la couverture

```sql
-- Counts
SELECT 'stats_joueurs' AS t, count(*) FROM core.stats_joueurs
UNION ALL SELECT 'equipe_id_resolu', count(equipe_id) FROM core.stats_joueurs
UNION ALL SELECT 'taux_resolution_pct',
       (count(equipe_id) * 100 / NULLIF(count(*), 0))::text::int FROM core.stats_joueurs;

-- Top 20 buteurs nationaux toutes compétitions confondues
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

- **National uniquement** : par design, le composant n'est pas exposé sur régional/dép. Le scraper filtre `niveau='national'` en amont → ~50-100 fetches au lieu de ~5k
- `core.joueurs` (table FFHB officielle) reste **vide** — les identités complètes nécessiteraient un accès GestHand authentifié
- L'`equipe_libelle` est conservé en clair même quand `equipe_id` est NULL — permet de matcher manuellement les cas non résolus ou d'enrichir via une feature future de fuzzy matching
- Volumétrie totale : ~15-30k lignes (287 joueurs × ~50-100 poules nationales)
- Re-run quotidien possible via cron (cf. `docs/DEPLOY.md`) — feature peu coûteuse à actualiser
```

- [ ] **Step 9.2 : Smoke test final**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'stats_joueurs' AS t, count(*) FROM core.stats_joueurs
   UNION ALL SELECT 'equipe_resolu', count(equipe_id) FROM core.stats_joueurs;"
```

- [ ] **Step 9.3 : Commit**

```bash
git add docs/runbook.md
git commit -m "$(cat <<'EOF'
docs(runbook): section stats-joueurs (national uniquement)

T9 : commandes scrape + ETL avec ordre étendu, SQL de suivi (top
buteurs, top gardiens, taux résolution équipe, fraîcheur, warnings),
notes opérationnelles (national-only par design, core.joueurs reste vide).

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

Expected : ~187 tests pass.

- [ ] **F.2 : Typecheck**

```bash
npm run typecheck
```

- [ ] **F.3 : Merge sur master + push**

```bash
git checkout master
git merge --no-ff feat/stats-joueurs -m "Merge feat/stats-joueurs: stats publiques national (8ème entité)"
git push origin master
```
