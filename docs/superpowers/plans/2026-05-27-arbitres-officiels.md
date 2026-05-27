# Arbitres + match_officiels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extraire les arbitres depuis `raw.matchs.payload` (déjà scrapé) vers `core.arbitres` et créer les liens `core.match_officiels` (match × arbitre × rôle). **Pas de scraping nouveau.**

**Architecture:** 2 ETLs purs lisant `raw.matchs.payload`. Helper `splitNomComplet` best-effort pour parser `"NOM Prénom"`. Migration 0011 assouplit `core.arbitres` (DROP NOT NULL sur `numero_licence`/`prenom`, ADD `id_ffhb`/`nom_complet`).

**Tech Stack:** TypeScript 5.7, Zod, Postgres 16 (UNION DISTINCT pour dédupliquer côté SQL), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-27-arbitres-officiels-design.md`

**Pré-requis :** branche `feat/arbitres-officiels` créée (déjà fait). `raw.matchs` doit avoir au moins quelques lignes pour les smoke tests (déjà le cas — 14+ matchs depuis T9 matchs).

---

### Task 1: Migration 0011 — assouplir core.arbitres

**Files:**
- Create: `db/migrations/0011_arbitres_assouplissement.sql`

- [ ] **Step 1.1 : Pré-vérification**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.arbitres"
```

Confirmer :
- `numero_licence` et `prenom` sont actuellement `NOT NULL`
- Pas de colonne `id_ffhb` ni `nom_complet`
- Contrainte UNIQUE `uq_arbitres_numero_licence` présente

- [ ] **Step 1.2 : Écrire la migration**

```sql
-- db/migrations/0011_arbitres_assouplissement.sql

ALTER TABLE core.arbitres ALTER COLUMN numero_licence DROP NOT NULL;
ALTER TABLE core.arbitres ALTER COLUMN prenom DROP NOT NULL;

ALTER TABLE core.arbitres ADD COLUMN IF NOT EXISTS id_ffhb TEXT;
ALTER TABLE core.arbitres ADD COLUMN IF NOT EXISTS nom_complet TEXT;

ALTER TABLE core.arbitres ADD CONSTRAINT uq_arbitres_id_ffhb UNIQUE (id_ffhb);

CREATE INDEX IF NOT EXISTS idx_arbitres_nom_trgm
  ON core.arbitres USING gin (nom gin_trgm_ops);
```

- [ ] **Step 1.3 : Lancer + vérifier**

```bash
npm run db:migrate
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.arbitres"
```

Confirmer après migration :
- `numero_licence` et `prenom` nullable
- Colonnes `id_ffhb text` et `nom_complet text` ajoutées
- Contrainte UNIQUE `uq_arbitres_id_ffhb` présente
- Index `idx_arbitres_nom_trgm` listé

- [ ] **Step 1.4 : Commit**

```bash
git add db/migrations/0011_arbitres_assouplissement.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 0011 — assouplir core.arbitres

T1 : DROP NOT NULL sur numero_licence (futur GestHand) et prenom
(split best effort imparfait), ajout id_ffhb TEXT UNIQUE (= arbitre_id
source) et nom_complet TEXT (backup brut). Index GIN trgm sur nom
pour fuzzy matching futur.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Helper `splitNomComplet` (pure function)

**Files:**
- Create: `src/etl/shared/split-nom-complet.ts`
- Create: `tests/etl/shared/split-nom-complet.test.ts`

- [ ] **Step 2.1 : Tests (failing)**

```ts
// tests/etl/shared/split-nom-complet.test.ts
import { describe, it, expect } from "vitest";
import { splitNomComplet } from "@/etl/shared/split-nom-complet.js";

describe("splitNomComplet", () => {
  it("splits 2-word name into nom + prenom (convention FFHB)", () => {
    expect(splitNomComplet("CHAMI MILOUD")).toEqual({ nom: "CHAMI", prenom: "MILOUD" });
  });

  it("returns prenom=null when single word", () => {
    expect(splitNomComplet("TOTO")).toEqual({ nom: "TOTO", prenom: null });
  });

  it("joins remaining words as prenom (3+ words)", () => {
    expect(splitNomComplet("JEAN-PIERRE DUPOND MARTIN")).toEqual({
      nom: "JEAN-PIERRE",
      prenom: "DUPOND MARTIN",
    });
  });

  it("normalizes multiple spaces", () => {
    expect(splitNomComplet("  CHAMI    MILOUD  ")).toEqual({ nom: "CHAMI", prenom: "MILOUD" });
  });

  it("throws on empty string", () => {
    expect(() => splitNomComplet("")).toThrow();
    expect(() => splitNomComplet("   ")).toThrow();
  });
});
```

- [ ] **Step 2.2 : Run failing**

```bash
npx vitest run tests/etl/shared/split-nom-complet.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 2.3 : Implémenter le helper**

```ts
// src/etl/shared/split-nom-complet.ts
export function splitNomComplet(nomComplet: string): { nom: string; prenom: string | null } {
  const trimmed = nomComplet.trim();
  if (trimmed === "") {
    throw new Error("Empty nom_complet");
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { nom: parts[0]!, prenom: null };
  }
  return { nom: parts[0]!, prenom: parts.slice(1).join(" ") };
}
```

- [ ] **Step 2.4 : Run passing**

```bash
npx vitest run tests/etl/shared/split-nom-complet.test.ts
```

Expected: 5 passed.

- [ ] **Step 2.5 : Commit**

```bash
git add src/etl/shared/split-nom-complet.ts tests/etl/shared/split-nom-complet.test.ts
git commit -m "$(cat <<'EOF'
feat: helper splitNomComplet (split nom/prenom best effort)

T2 : fonction pure, convention FFHB "NOM Prénom" (premier mot = nom,
reste = prenom). Cas single-word : prenom=null. Throw sur chaîne vide.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: ETL arbitres

**Files:**
- Create: `src/etl/arbitres.etl.ts`
- Create: `tests/etl/arbitres.etl.test.ts`

- [ ] **Step 3.1 : Tests (failing)**

```ts
// tests/etl/arbitres.etl.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runArbitresEtl } from "@/etl/arbitres.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function insertRawMatch(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','matchs',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.matchs (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runArbitresEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='matchs'`);
    await query(`TRUNCATE core.match_officiels, core.arbitres, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("extracts unique arbitres from raw.matchs (UNION arbitre1 + arbitre2)", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
        arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME",
      },
      "M1",
    );
    await insertRawMatch(
      {
        ext_rencontre_id: "M2",
        arbitre1_id: "A3", arbitre1_nom: "COURNIL MATHILDE",
        arbitre2_id: "A4", arbitre2_nom: "LAMOUR LORIANE",
      },
      "M2",
    );
    const report = await runArbitresEtl(SAISON);
    expect(report.rows_inserted).toBe(4);
    const all = await query<{ id_ffhb: string; nom: string; prenom: string }>(
      `SELECT id_ffhb, nom, prenom FROM core.arbitres ORDER BY id_ffhb`,
    );
    expect(all.rowCount).toBe(4);
    expect(all.rows.map((r) => r.id_ffhb)).toEqual(["A1", "A2", "A3", "A4"]);
  });

  it("deduplicates same arbitre appearing in multiple matchs", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
        arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME",
      },
      "M1",
    );
    await insertRawMatch(
      {
        ext_rencontre_id: "M2",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",  // same as M1
        arbitre2_id: "A3", arbitre2_nom: "AUTRE NOM",
      },
      "M2",
    );
    const report = await runArbitresEtl(SAISON);
    expect(report.rows_inserted).toBe(3);  // A1, A2, A3 (pas 4)
    const a1 = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres WHERE id_ffhb = 'A1'`);
    expect(Number(a1.rows[0]!.count)).toBe(1);
  });

  it("splits nom_complet into nom + prenom + stores nom_complet brut", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
      },
      "M1",
    );
    await runArbitresEtl(SAISON);
    const a1 = await query<{ nom: string; prenom: string | null; nom_complet: string | null }>(
      `SELECT nom, prenom, nom_complet FROM core.arbitres WHERE id_ffhb = 'A1'`,
    );
    expect(a1.rows[0]!.nom).toBe("CHAMI");
    expect(a1.rows[0]!.prenom).toBe("MILOUD");
    expect(a1.rows[0]!.nom_complet).toBe("CHAMI MILOUD");
  });

  it("skips raw matchs with no arbitre data", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        // No arbitre1_id or arbitre2_id
      },
      "M1",
    );
    const report = await runArbitresEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    const all = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`);
    expect(Number(all.rows[0]!.count)).toBe(0);
  });

  it("is idempotent (re-run → same counts)", async () => {
    await insertRawMatch(
      {
        ext_rencontre_id: "M1",
        arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD",
      },
      "M1",
    );
    await runArbitresEtl(SAISON);
    await runArbitresEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`);
    expect(Number(r.rows[0]!.count)).toBe(1);
  });
});
```

- [ ] **Step 3.2 : Run failing**

```bash
npx vitest run tests/etl/arbitres.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3.3 : Implémenter `arbitres.etl.ts`**

```ts
// src/etl/arbitres.etl.ts
import { query } from "@/db/client.js";
import { splitNomComplet } from "@/etl/shared/split-nom-complet.js";
import { logger } from "@/lib/logger.js";

interface ArbitreUnique {
  id_ffhb: string;
  nom_complet: string;
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

export async function runArbitresEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('arbitres', $1) RETURNING id`,
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
    const arbitresRes = await query<ArbitreUnique>(
      `SELECT DISTINCT id_ffhb, nom_complet FROM (
         SELECT payload->>'arbitre1_id'  AS id_ffhb,
                payload->>'arbitre1_nom' AS nom_complet
           FROM raw.matchs
          WHERE saison = $1
            AND payload->>'arbitre1_id'  IS NOT NULL
            AND payload->>'arbitre1_nom' IS NOT NULL
         UNION
         SELECT payload->>'arbitre2_id'  AS id_ffhb,
                payload->>'arbitre2_nom' AS nom_complet
           FROM raw.matchs
          WHERE saison = $1
            AND payload->>'arbitre2_id'  IS NOT NULL
            AND payload->>'arbitre2_nom' IS NOT NULL
       ) AS u
       WHERE id_ffhb <> '' AND nom_complet <> ''`,
      [saison],
    );
    report.rows_read = arbitresRes.rowCount ?? 0;

    for (const row of arbitresRes.rows) {
      let nom: string;
      let prenom: string | null;
      try {
        const split = splitNomComplet(row.nom_complet);
        nom = split.nom;
        prenom = split.prenom;
      } catch (err) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'arbitres',NULL,$2,$3,$4)`,
          [etl_run_id, row.id_ffhb, JSON.stringify(row), String((err as Error).message)],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.arbitres (id_ffhb, nom, prenom, nom_complet, last_seen_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom         = EXCLUDED.nom,
             prenom      = COALESCE(EXCLUDED.prenom, core.arbitres.prenom),
             nom_complet = EXCLUDED.nom_complet,
             last_seen_at = now(),
             updated_at  = CASE
               WHEN core.arbitres.nom IS DISTINCT FROM EXCLUDED.nom
                 OR (EXCLUDED.prenom IS NOT NULL AND core.arbitres.prenom IS DISTINCT FROM EXCLUDED.prenom)
                 OR core.arbitres.nom_complet IS DISTINCT FROM EXCLUDED.nom_complet
               THEN now()
               ELSE core.arbitres.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [row.id_ffhb, nom, prenom, row.nom_complet],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
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

    logger.info(report, "arbitres ETL done");
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

- [ ] **Step 3.4 : Run tests passing**

```bash
npx vitest run tests/etl/arbitres.etl.test.ts
```

Expected: 5 passed.

⚠️ Pas de `afterAll(closePool)` ici (sera dans T4 match_officiels).

- [ ] **Step 3.5 : Commit**

```bash
git add src/etl/arbitres.etl.ts tests/etl/arbitres.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL arbitres (extraction depuis raw.matchs)

T3 : SELECT DISTINCT depuis raw.matchs via UNION arbitre1+arbitre2.
Split nom_complet via helper. UPSERT par id_ffhb avec COALESCE prenom
et CASE updated_at conditionnel. Pas de raw nouveau, pas de scraping.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ETL match_officiels (avec FK match + arbitre)

**Files:**
- Create: `src/etl/match_officiels.etl.ts`
- Create: `tests/etl/match_officiels.etl.test.ts`

- [ ] **Step 4.1 : Tests (failing)**

```ts
// tests/etl/match_officiels.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runMatchOfficielsEtl } from "@/etl/match_officiels.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extMatchId: string): Promise<{ match_id: number }> {
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
     VALUES ('PO1', $1, 'Poule', $2)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ('EDOM', 'Dom', $1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code)
     VALUES ('EEXT', 'Ext', $1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const match = await query<{ id: number }>(
    `INSERT INTO core.matchs (
       id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure
     ) VALUES ($1, $2, $3, $4, '2025-09-03T20:00:00+02:00') RETURNING id`,
    [extMatchId, poule.rows[0]!.id, eqDom.rows[0]!.id, eqExt.rows[0]!.id],
  );
  return { match_id: match.rows[0]!.id };
}

async function seedArbitre(idFfhb: string, nom: string): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO core.arbitres (id_ffhb, nom, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [idFfhb, nom],
  );
  return r.rows[0]!.id;
}

async function insertRawMatch(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','matchs',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.matchs (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("runMatchOfficielsEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='matchs'`);
    await query(`TRUNCATE core.match_officiels, core.matchs, core.arbitres, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("inserts 2 lignes (arbitre_1, arbitre_2) when both arbitres present", async () => {
    const { match_id } = await seedHierarchy("M1");
    const a1 = await seedArbitre("A1", "CHAMI");
    const a2 = await seedArbitre("A2", "MILI");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre2_id: "A2" },
      "M1",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(2);
    expect(report.warnings_count).toBe(0);
    const r = await query<{ role: string; arbitre_id: number }>(
      `SELECT role, arbitre_id FROM core.match_officiels WHERE match_id = $1 ORDER BY role`,
      [match_id],
    );
    expect(r.rowCount).toBe(2);
    expect(r.rows[0]!.role).toBe("arbitre_1");
    expect(r.rows[0]!.arbitre_id).toBe(a1);
    expect(r.rows[1]!.role).toBe("arbitre_2");
    expect(r.rows[1]!.arbitre_id).toBe(a2);
  });

  it("inserts only arbitre_1 when arbitre2_id is absent", async () => {
    const { match_id } = await seedHierarchy("M1");
    await seedArbitre("A1", "CHAMI");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1" },
      "M1",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    const r = await query<{ role: string }>(
      `SELECT role FROM core.match_officiels WHERE match_id = $1`,
      [match_id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.role).toBe("arbitre_1");
  });

  it("warns and skips when match FK not resolved", async () => {
    await seedArbitre("A1", "CHAMI");
    await insertRawMatch(
      { ext_rencontre_id: "GHOST_MATCH", arbitre1_id: "A1" },
      "GHOST_MATCH",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(0);
    expect(report.warnings_count).toBe(1);
  });

  it("warns and skips one arbitre when its FK not resolved, inserts the other", async () => {
    await seedHierarchy("M1");
    await seedArbitre("A1", "CHAMI");
    // A2 not seeded → FK arbitre2 will fail
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre2_id: "GHOST_ARBITRE" },
      "M1",
    );
    const report = await runMatchOfficielsEtl(SAISON);
    expect(report.rows_inserted).toBe(1);  // arbitre_1 inséré, arbitre_2 skip
    expect(report.warnings_count).toBe(1);
  });

  it("is idempotent via ON CONFLICT DO NOTHING on PK (match, arbitre, role)", async () => {
    await seedHierarchy("M1");
    await seedArbitre("A1", "CHAMI");
    await seedArbitre("A2", "MILI");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre2_id: "A2" },
      "M1",
    );
    await runMatchOfficielsEtl(SAISON);
    await runMatchOfficielsEtl(SAISON);
    const r = await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`);
    expect(Number(r.rows[0]!.count)).toBe(2);
  });

  afterAll(async () => {
    await closePool();
  });
});
```

- [ ] **Step 4.2 : Run failing**

```bash
npx vitest run tests/etl/match_officiels.etl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4.3 : Implémenter `match_officiels.etl.ts`**

```ts
// src/etl/match_officiels.etl.ts
import { query } from "@/db/client.js";
import { logger } from "@/lib/logger.js";

interface RawMatchOfficielsRow {
  ext_rencontre_id: string;
  arbitre1_id: string | null;
  arbitre2_id: string | null;
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

async function resolveMatchId(extRencontreId: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.matchs WHERE id_ffhb_match = $1`,
    [extRencontreId],
  );
  return r.rows[0]?.id ?? null;
}

async function resolveArbitreId(idFfhb: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.arbitres WHERE id_ffhb = $1`,
    [idFfhb],
  );
  return r.rows[0]?.id ?? null;
}

export async function runMatchOfficielsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('match_officiels', $1) RETURNING id`,
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
    // DISTINCT ON pour la dernière version raw par match
    const rawRes = await query<RawMatchOfficielsRow>(
      `SELECT DISTINCT ON (natural_key)
              payload->>'ext_rencontre_id' AS ext_rencontre_id,
              payload->>'arbitre1_id'      AS arbitre1_id,
              payload->>'arbitre2_id'      AS arbitre2_id
         FROM raw.matchs
        WHERE saison = $1
          AND (payload->>'arbitre1_id' IS NOT NULL OR payload->>'arbitre2_id' IS NOT NULL)
        ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRes.rowCount ?? 0;

    for (const row of rawRes.rows) {
      if (!row.ext_rencontre_id) continue;
      report.rows_validated++;

      const match_id = await resolveMatchId(row.ext_rencontre_id);
      if (match_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'match_officiels',$2,$3)`,
          [etl_run_id, row.ext_rencontre_id, `match ${row.ext_rencontre_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      for (const [field, role] of [
        ["arbitre1_id", "arbitre_1"] as const,
        ["arbitre2_id", "arbitre_2"] as const,
      ]) {
        const idFfhb = field === "arbitre1_id" ? row.arbitre1_id : row.arbitre2_id;
        if (!idFfhb || idFfhb === "") continue;

        const arbitre_id = await resolveArbitreId(idFfhb);
        if (arbitre_id === null) {
          await query(
            `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
             VALUES ($1,'match_officiels',$2,$3)`,
            [
              etl_run_id,
              `${row.ext_rencontre_id}-${role}`,
              `arbitre ${idFfhb} introuvable`,
            ],
          );
          report.warnings_count++;
          continue;
        }

        const insertRes = await query<{ inserted: boolean }>(
          `INSERT INTO core.match_officiels (match_id, arbitre_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (match_id, arbitre_id, role) DO NOTHING
           RETURNING (xmax = 0) AS inserted`,
          [match_id, arbitre_id, role],
        );

        if (insertRes.rowCount && insertRes.rowCount > 0 && insertRes.rows[0]!.inserted) {
          report.rows_inserted++;
        } else {
          report.rows_noop++;
        }
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
        report.rows_read, report.rows_validated, report.rows_rejected,
        report.rows_inserted, report.rows_updated, report.rows_noop, report.warnings_count,
      ],
    );

    logger.info(report, "match_officiels ETL done");
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

- [ ] **Step 4.4 : Run tests passing**

```bash
npx vitest run tests/etl/match_officiels.etl.test.ts
```

Expected: 5 passed.

- [ ] **Step 4.5 : Commit**

```bash
git add src/etl/match_officiels.etl.ts tests/etl/match_officiels.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL match_officiels (FK match + FK arbitre par rôle)

T4 : SELECT DISTINCT ON depuis raw.matchs filtré sur arbitre1_id ou
arbitre2_id présent. Pour chaque match : résolution FK match + FK
arbitre par rôle. Warning + skip granulaire (un arbitre orphelin
n'empêche pas l'autre). Idempotent via ON CONFLICT DO NOTHING sur
PK composite (match, arbitre, role).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLI etl dispatch arbitres + match_officiels

**Files:**
- Modify: `src/cli/etl.ts`

- [ ] **Step 5.1 : Ajouter imports + dispatches**

```ts
// Imports en tête
import { runArbitresEtl } from "@/etl/arbitres.etl.js";
import { runMatchOfficielsEtl } from "@/etl/match_officiels.etl.js";

// Dans main(), après le dispatch matchs :
} else if (args.entity === "arbitres") {
  await runArbitresEtl(args.saison);
} else if (args.entity === "match_officiels") {
  await runMatchOfficielsEtl(args.saison);
```

- [ ] **Step 5.2 : Tester la chaîne sur dev**

Pré-requis : `raw.matchs` peuplée (smoke test T9 matchs précédente — il y a déjà ~14 matchs avec arbitres). Si la base est vide, refaire un mini-scrape :

```bash
# Si nécessaire (si raw.matchs vide)
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --limit=3
```

Puis :

```bash
npm run etl -- --entity=arbitres        --saison=2025-2026
npm run etl -- --entity=match_officiels --saison=2025-2026
```

Vérifier :

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'arbitres' AS t, count(*) FROM core.arbitres
   UNION ALL SELECT 'match_officiels', count(*) FROM core.match_officiels
   UNION ALL SELECT 'arbitres_avec_prenom', count(prenom) FROM core.arbitres
   UNION ALL SELECT 'warnings_arbitres', count(*) FROM core.etl_warnings WHERE entity='arbitres'
   UNION ALL SELECT 'warnings_officiels', count(*) FROM core.etl_warnings WHERE entity='match_officiels';"
```

Expected : ~30-40 arbitres uniques, ~30-40 lignes match_officiels (2 par match × N matchs joués qui ont des arbitres), warnings_arbitres = 0, warnings_officiels = 0 si la chaîne complète est OK.

- [ ] **Step 5.3 : Commit**

```bash
git add src/cli/etl.ts
git commit -m "$(cat <<'EOF'
feat(cli): etl --entity=arbitres|match_officiels

T5 : dispatch des 2 nouveaux ETL. Ordre complet désormais :
competitions → phases → poules → equipes → engagements → matchs
→ arbitres → match_officiels.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Test intégration end-to-end

**Files:**
- Create: `tests/integration/arbitres-officiels-end-to-end.test.ts`

- [ ] **Step 6.1 : Écrire le test**

```ts
// tests/integration/arbitres-officiels-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { query } from "@/db/client.js";
import { runArbitresEtl } from "@/etl/arbitres.etl.js";
import { runMatchOfficielsEtl } from "@/etl/match_officiels.etl.js";

const SAISON = "2025-2026";

async function setup(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedHierarchy(extMatchId: string): Promise<{ match_id: number }> {
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1','C','national',$1) ON CONFLICT (id_ffhb) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const phase = await query<{ id: number }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ('PH1', $1, 'P', $2) ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const poule = await query<{ id: number }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
     VALUES ('PO1', $1, 'Poule', $2) ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EDOM','Dom',$1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EEXT','Ext',$1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const match = await query<{ id: number }>(
    `INSERT INTO core.matchs (
       id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure
     ) VALUES ($1, $2, $3, $4, '2025-09-03T20:00:00+02:00') RETURNING id`,
    [extMatchId, poule.rows[0]!.id, eqDom.rows[0]!.id, eqExt.rows[0]!.id],
  );
  return { match_id: match.rows[0]!.id };
}

async function insertRawMatch(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('ffhandball.fr','matchs',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.matchs (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

describe("arbitres + match_officiels end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.matchs`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name='matchs'`);
    await query(`TRUNCATE core.match_officiels, core.matchs, core.arbitres, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();
  });

  it("3 matchs → arbitres ETL → match_officiels ETL → core populated correctly", async () => {
    // Seed 3 matchs (chacun avec ses 2 arbitres, certains arbitres répétés)
    const { match_id: m1 } = await seedHierarchy("M1");
    const { match_id: m2 } = await seedHierarchy("M2");
    const { match_id: m3 } = await seedHierarchy("M3");
    // Note: seedHierarchy re-utilise les mêmes competition/phase/poule à cause des ON CONFLICT,
    // mais crée 3 matchs distincts
    void m1; void m2; void m3;

    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD", arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME" },
      "M1",
    );
    await insertRawMatch(
      { ext_rencontre_id: "M2", arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD", arbitre2_id: "A3", arbitre2_nom: "COURNIL MATHILDE" },
      "M2",
    );
    await insertRawMatch(
      { ext_rencontre_id: "M3", arbitre1_id: "A2", arbitre1_nom: "MILI AISSAME", arbitre2_id: "A3", arbitre2_nom: "COURNIL MATHILDE" },
      "M3",
    );

    // Run arbitres puis match_officiels
    const arbReport = await runArbitresEtl(SAISON);
    expect(arbReport.rows_inserted).toBe(3); // A1, A2, A3 (déduplication)
    expect(arbReport.warnings_count).toBe(0);

    const officielsReport = await runMatchOfficielsEtl(SAISON);
    expect(officielsReport.rows_inserted).toBe(6); // 3 matchs × 2 arbitres
    expect(officielsReport.warnings_count).toBe(0);

    // Vérifications finales
    const arbCount = await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`);
    expect(Number(arbCount.rows[0]!.count)).toBe(3);
    const officielsCount = await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`);
    expect(Number(officielsCount.rows[0]!.count)).toBe(6);

    // A1 a officié dans 2 matchs
    const a1 = await query<{ count: string }>(
      `SELECT count(*) FROM core.match_officiels mo
       JOIN core.arbitres a ON a.id = mo.arbitre_id
       WHERE a.id_ffhb = 'A1'`,
    );
    expect(Number(a1.rows[0]!.count)).toBe(2);

    // Split nom/prenom OK
    const chami = await query<{ nom: string; prenom: string | null; nom_complet: string | null }>(
      `SELECT nom, prenom, nom_complet FROM core.arbitres WHERE id_ffhb = 'A1'`,
    );
    expect(chami.rows[0]!.nom).toBe("CHAMI");
    expect(chami.rows[0]!.prenom).toBe("MILOUD");
    expect(chami.rows[0]!.nom_complet).toBe("CHAMI MILOUD");
  });

  it("is idempotent (re-run ETLs = same counts)", async () => {
    await seedHierarchy("M1");
    await insertRawMatch(
      { ext_rencontre_id: "M1", arbitre1_id: "A1", arbitre1_nom: "CHAMI MILOUD", arbitre2_id: "A2", arbitre2_nom: "MILI AISSAME" },
      "M1",
    );
    await runArbitresEtl(SAISON);
    await runMatchOfficielsEtl(SAISON);

    const beforeArb = (await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`)).rows[0]!.count;
    const beforeOff = (await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`)).rows[0]!.count;

    await runArbitresEtl(SAISON);
    await runMatchOfficielsEtl(SAISON);

    const afterArb = (await query<{ count: string }>(`SELECT count(*) FROM core.arbitres`)).rows[0]!.count;
    const afterOff = (await query<{ count: string }>(`SELECT count(*) FROM core.match_officiels`)).rows[0]!.count;

    expect(afterArb).toBe(beforeArb);
    expect(afterOff).toBe(beforeOff);
  });
});
```

⚠️ Pas de `afterAll(closePool)` ici (T4/match_officiels.etl.test.ts l'a déjà).

- [ ] **Step 6.2 : Run + suite complète**

```bash
npx vitest run tests/integration/arbitres-officiels-end-to-end.test.ts
```

Expected : 2 passed.

```bash
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
```

Expected : 129 + 5 (T2) + 5 (T3) + 5 (T4) + 2 (T6) = ~146 tests pass.

- [ ] **Step 6.3 : Commit**

```bash
git add tests/integration/arbitres-officiels-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
test: intégration end-to-end arbitres + match_officiels

T6 : 3 matchs avec arbitres partagés → 3 arbitres uniques (déduplication)
→ 6 lignes match_officiels (2 par match), un arbitre officie 2 fois.
Idempotence du re-run des 2 ETLs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Runbook section arbitres + smoke test final

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 7.1 : Ajouter la section**

Ajouter à la fin de `docs/runbook.md` :

```markdown
## ETL arbitres et match_officiels

Pas de scraping nouveau. Les arbitres sont extraits depuis `raw.matchs.payload`
(champs `arbitre1_id/nom` et `arbitre2_id/nom` capturés lors du scrape des matchs).
2 ETLs en cascade alimentent `core.arbitres` puis `core.match_officiels`.

### ETL — ordre obligatoire

```bash
# Pré-requis : raw.matchs déjà peuplée (cf. section "Scraper les matchs")

npm run etl -- --entity=arbitres        --saison=2025-2026
npm run etl -- --entity=match_officiels --saison=2025-2026
```

L'ordre `arbitres → match_officiels` est obligatoire (le second résout FK vers `core.arbitres`).

### Suivre la couverture

```sql
-- Comptes
SELECT 'arbitres' AS t, count(*) FROM core.arbitres
UNION ALL SELECT 'avec_prenom', count(prenom) FROM core.arbitres
UNION ALL SELECT 'match_officiels', count(*) FROM core.match_officiels;

-- Top 20 arbitres par nombre de matchs officiés
SELECT a.id_ffhb, a.nom, a.prenom, count(*) AS nb_matchs
  FROM core.match_officiels mo
  JOIN core.arbitres a ON a.id = mo.arbitre_id
  GROUP BY a.id, a.id_ffhb, a.nom, a.prenom
  ORDER BY nb_matchs DESC LIMIT 20;

-- Répartition par rôle
SELECT role, count(*) FROM core.match_officiels GROUP BY role;

-- Matchs sans arbitre (pas attendu, sauf si arbitre1/2 manquaient en source)
SELECT count(*) FROM core.matchs m
  WHERE NOT EXISTS (
    SELECT 1 FROM core.match_officiels mo WHERE mo.match_id = m.id
  );

-- Warnings ETL
SELECT entity, message, count(*) FROM core.etl_warnings
  WHERE entity IN ('arbitres', 'match_officiels')
    AND etl_run_id >= (SELECT max(id)-1 FROM core.etl_runs WHERE entity = 'arbitres')
  GROUP BY entity, message ORDER BY count(*) DESC;
```

### Rejouer après bug

```sql
TRUNCATE core.match_officiels;
TRUNCATE core.arbitres CASCADE;
```

Puis re-lancer les 2 ETLs dans l'ordre. `raw.matchs` n'est pas touché.

### Notes opérationnelles

- Le `nom_complet` brut est conservé pour permettre une future réconciliation (split imparfait sur ~5% des cas : noms composés, particules)
- `numero_licence` reste **NULL** (pas exposé publiquement par ffhandball.fr — derrière login GestHand)
- `club_rattachement_id` reste **NULL** (pas exposé non plus)
- `niveau` reste **NULL** (T1/T2/territorial/départemental non exposés)
- Volumétrie attendue après scrape complet matchs : ~5-15k arbitres uniques, ~100-400k lignes match_officiels
- Si un re-scrape matchs ajoute des arbitres jamais vus, ré-exécuter `arbitres` puis `match_officiels` ETL
```

- [ ] **Step 7.2 : Smoke test final**

```bash
# Vérifier que raw.matchs a des données ; sinon rescrape minimal
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "SELECT count(*) FROM raw.matchs;"

# Lancer les 2 ETLs
npm run etl -- --entity=arbitres        --saison=2025-2026
npm run etl -- --entity=match_officiels --saison=2025-2026

# Vérifier
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'arbitres' AS t, count(*) FROM core.arbitres
   UNION ALL SELECT 'match_officiels', count(*) FROM core.match_officiels;"
```

- [ ] **Step 7.3 : Commit**

```bash
git add docs/runbook.md
git commit -m "$(cat <<'EOF'
docs(runbook): section arbitres + match_officiels

T7 : ordre ETL obligatoire (arbitres puis match_officiels), SQL de
suivi (top arbitres par matchs officiés, répartition rôles, matchs
sans arbitre, warnings), notes opérationnelles.

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

Expected : ~146 tests pass, 0 fail.

- [ ] **F.2 : Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

Expected : 0 erreurs.

- [ ] **F.3 : Merge sur master**

```bash
git checkout master
git merge --no-ff feat/arbitres-officiels -m "Merge feat/arbitres-officiels: extraction arbitres depuis raw.matchs"
```
