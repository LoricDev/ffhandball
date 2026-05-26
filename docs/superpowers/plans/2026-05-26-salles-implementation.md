# Salles + Clubs Detail Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer l'entité `salles` et enrichir l'entité `clubs` en scrapant les fiches détail club de ffhandball.fr — une seule requête HTTP par club produit deux payloads raw (clubs enrichi + salles), consommés par deux ETL distincts.

**Architecture:** Nouveau scraper `club-details.scraper.ts` qui itère sur `core.clubs`, fetch chaque fiche détail, parse via Cheerio en pure-function et retourne `{ club, salle }`. Deux pipelines downstream : `salles.etl` (nouveau) et `clubs.etl` (étendu pour résoudre `salle_principale_id` et mapper les nouveaux champs).

**Tech Stack:** TypeScript 5.7, Node 20+, Postgres 16, Cheerio, Zod, pg, Vitest, tsx — patterns identiques au pilote clubs (cf. `docs/superpowers/plans/2026-05-18-ffhandball-pilot-implementation.md`).

**Référence design :** [docs/superpowers/specs/2026-05-26-salles-design.md](../specs/2026-05-26-salles-design.md)

---

## File Structure

```
ffhandball/
├── db/migrations/
│   └── 0007_enrich_core_clubs.sql           (NEW)
│
├── scripts/
│   └── explore-club-detail.ts               (NEW — jetable, non versionné)
│
├── src/
│   ├── schemas/
│   │   ├── club.schema.ts                   (MODIFIED — champs optionnels)
│   │   └── salle.schema.ts                  (NEW)
│   ├── scrapers/ffhandball/
│   │   └── club-details.scraper.ts          (NEW)
│   ├── etl/
│   │   ├── clubs.etl.ts                     (MODIFIED — FK salle + nouveaux champs)
│   │   └── salles.etl.ts                    (NEW)
│   └── cli/
│       ├── scrape.ts                        (MODIFIED — entity club-details)
│       └── etl.ts                           (MODIFIED — entity salles)
│
├── tests/
│   ├── fixtures/
│   │   ├── ffhandball-club-detail-complet.html      (NEW)
│   │   ├── ffhandball-club-detail-minimal.html      (NEW)
│   │   └── ffhandball-club-detail-sans-salle.html   (NEW)
│   ├── scrapers/
│   │   └── club-details.scraper.test.ts             (NEW)
│   ├── etl/
│   │   └── salles.etl.test.ts                       (NEW)
│   └── integration/
│       └── club-details-end-to-end.test.ts          (NEW)
│
└── docs/
    ├── club-detail-fields.md                (NEW — inventaire post-exploration)
    └── runbook.md                           (MODIFIED — section enrichissement)
```

**Responsabilités :**
- `scripts/explore-club-detail.ts` : script jetable de découverte, dump du HTML vers `tests/fixtures/` + inventaire dans `docs/club-detail-fields.md`. Ajouté au `.gitignore` (le script reste local).
- `src/schemas/salle.schema.ts` : source de vérité du payload `raw.salles`
- `src/scrapers/ffhandball/club-details.scraper.ts` : fonction pure `parseClubDetail(html, sourceUrl) → { club: RawClubPayload, salle: RawSallePayload | null }`
- `src/etl/salles.etl.ts` : `raw.salles → core.salles`, validation Zod, UPSERT par `id_ffhb`
- `src/etl/clubs.etl.ts` (modifié) : ajoute la résolution `salle_principale_id` et le mapping des nouveaux champs de `core.clubs`

---

## Phase 1 — Exploration manuelle

### Task 1 : Découvrir le HTML des fiches détail club

Cette tâche est **manuelle et exploratoire**. Elle ne produit pas de code applicatif mais conditionne tout le reste du plan (sélecteurs, champs Zod, colonnes DB).

**Files:**
- Create: `scripts/explore-club-detail.ts` (script jetable, ignoré par git)
- Create: `tests/fixtures/ffhandball-club-detail-complet.html`
- Create: `tests/fixtures/ffhandball-club-detail-minimal.html`
- Create: `tests/fixtures/ffhandball-club-detail-sans-salle.html`
- Create: `docs/club-detail-fields.md`
- Modify: `.gitignore` (ajouter `scripts/`)

- [ ] **Step 1.1 : Ajouter `scripts/` au `.gitignore`**

Edit `.gitignore`, ajouter en fin :
```
scripts/
```

- [ ] **Step 1.2 : Écrire `scripts/explore-club-detail.ts`**

```ts
import { writeFileSync } from "node:fs";
import { fetchHtml } from "@/scrapers/shared/http-client.js";
import { query, closePool } from "@/db/client.js";

// Sélection manuelle : un échantillon représentatif
// (1 grand club D1, 1 club départemental, 1 outre-mer, 1 sans salle déclarée…)
const SAMPLES: Array<{ id_ffhb: string; label: string }> = [
  // Remplir manuellement après avoir interrogé core.clubs :
  // SELECT id_ffhb, nom, departement_id FROM core.clubs ORDER BY random() LIMIT 20;
  // Choisir ~8 ids variés.
];

async function main(): Promise<void> {
  for (const { id_ffhb, label } of SAMPLES) {
    const url = `https://www.ffhandball.fr/clubs/${id_ffhb}`;
    try {
      const res = await fetchHtml(url);
      const path = `tests/fixtures/club-detail-${id_ffhb}.html`;
      writeFileSync(path, res.body, "utf8");
      console.log(`✓ ${label} → ${path} (${res.body.length} bytes)`);
    } catch (err) {
      console.error(`✗ ${id_ffhb} (${label})`, err);
    }
  }
}

main().finally(closePool);
```

- [ ] **Step 1.3 : Lancer l'exploration**

Run:
```bash
node --import tsx --env-file=.env scripts/explore-club-detail.ts
```
Expected : 8 fichiers HTML dans `tests/fixtures/club-detail-*.html`.

Si le pattern URL `ffhandball.fr/clubs/<id_ffhb>` retourne 404, essayer d'autres patterns (`/clubs/fiche/<id>`, slug par nom…) en inspectant un lien sortant d'une page listing. **Documenter le pattern retenu** dans `docs/club-detail-fields.md`.

- [ ] **Step 1.4 : Ouvrir 3 des fixtures dans un navigateur et inventorier**

Pour chacun des HTML, ouvrir en local et noter dans `docs/club-detail-fields.md` :

```markdown
# Inventaire des champs — fiche détail club ffhandball.fr

## Pattern URL retenu

`https://www.ffhandball.fr/clubs/<id_ffhb>` (à confirmer/corriger après exploration)

## Champs observés

| Champ candidat | Sélecteur CSS | Fréquence | Exemple |
|---|---|---|---|
| nom_club | `h1.club-name` | toujours | "HBC Trifouilly" |
| telephone | `.contact-phone` | parfois | "01 23 45 67 89" |
| email | `.contact-email` | parfois | "contact@trifouilly.fr" |
| site_web | `.contact-web a@href` | rarement | "https://..." |
| salle_nom | `.salle .nom` | souvent | "Gymnase Léo Lagrange" |
| salle_adresse | `.salle .adresse` | souvent | "12 rue du Stade" |
| salle_code_postal | `.salle .cp` | souvent | "75001" |
| salle_ville | `.salle .ville` | souvent | "Paris" |
| salle_id_ffhb | `.salle@data-id` | si présent | "S00123" |
| effectif | `.club-meta .effectif` | rarement | "120 licenciés" |

## Décisions

- Si `salle_id_ffhb` absent : natural_key dérivée = `slug(salle_nom + code_postal + ville)`
- Champs jamais observés : (à compléter)
- Cas dégradés : club sans bloc `.salle` → salle = null
```

Les noms de sélecteurs ci-dessus sont des **exemples illustratifs**. Remplacer par ceux réellement observés dans le HTML.

- [ ] **Step 1.5 : Sélectionner 3 fixtures représentatives et les renommer**

Parmi les ~8 fichiers dumpés, choisir 3 cas distincts :

```bash
mv tests/fixtures/club-detail-<id_riche>.html      tests/fixtures/ffhandball-club-detail-complet.html
mv tests/fixtures/club-detail-<id_pauvre>.html     tests/fixtures/ffhandball-club-detail-minimal.html
mv tests/fixtures/club-detail-<id_sans_salle>.html tests/fixtures/ffhandball-club-detail-sans-salle.html
rm tests/fixtures/club-detail-*.html
```

- [ ] **Step 1.6 : Commit**

```bash
git add .gitignore tests/fixtures/ffhandball-club-detail-*.html docs/club-detail-fields.md
git commit -m "docs(salles): inventory of club detail fields + 3 fixtures"
```

---

## Phase 2 — Schémas et migration

### Task 2 : Schéma Zod `salle.schema.ts`

**Files:**
- Create: `src/schemas/salle.schema.ts`

- [ ] **Step 2.1 : Écrire le schéma**

```ts
// src/schemas/salle.schema.ts
import { z } from "zod";

export const rawSallePayloadSchema = z.object({
  // natural_key : id_ffhb officiel si exposé par le site, sinon fallback slug
  // (cf. docs/club-detail-fields.md pour la règle exacte retenue à l'exploration)
  id_ffhb: z.string().min(1),
  nom: z.string().min(1),
  adresse: z.string().optional(),
  code_postal: z.string().regex(/^\d{5}$/).optional(),
  ville: z.string().optional(),
  departement_code: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional(),
  capacite: z.coerce.number().int().positive().optional(),
  source_url: z.string().url(),
  source_club_id_ffhb: z.string().min(1),
});

export type RawSallePayload = z.infer<typeof rawSallePayloadSchema>;
```

Si l'exploration a révélé d'autres champs (GPS, code IRIS…), les ajouter ici en `optional()`.

- [ ] **Step 2.2 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 2.3 : Commit**

```bash
git add src/schemas/salle.schema.ts
git commit -m "feat(schemas): raw.salles payload schema"
```

---

### Task 3 : Étendre `club.schema.ts`

**Files:**
- Modify: `src/schemas/club.schema.ts`

- [ ] **Step 3.1 : Étendre le schéma — tous les nouveaux champs optionnels**

Remplacer le contenu actuel de `src/schemas/club.schema.ts` par :

```ts
import { z } from "zod";

export const rawClubPayloadSchema = z.object({
  // Champs passe 1 (listing) — inchangés
  id_ffhb: z.string().regex(/^\d+$/, "id_ffhb must be digits"),
  nom: z.string().min(1),
  ville: z.string().optional(),
  departement_code: z.string().regex(/^(\d{2,3}|2A|2B)$/).optional(),
  source_url: z.string().url(),

  // Champs passe 2 (fiche détail) — tous optionnels pour rétrocompat
  // Conserver/retirer/ajouter selon docs/club-detail-fields.md
  telephone: z.string().optional(),
  email: z.string().email().optional(),
  site_web: z.string().url().optional(),
  adresse_correspondance: z.string().optional(),
  salle_principale_id_ffhb: z.string().optional(),
  effectif_estime: z.coerce.number().int().nonnegative().optional(),
});

export type RawClubPayload = z.infer<typeof rawClubPayloadSchema>;
```

**Important :** les champs nouveaux sont tous `optional()`. Cela garantit que les payloads passe 1 déjà stockés en `raw.clubs` (qui n'ont que les 5 premiers champs) restent valides au prochain re-run de `clubs.etl`.

- [ ] **Step 3.2 : Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3.3 : Commit**

```bash
git add src/schemas/club.schema.ts
git commit -m "feat(schemas): extend club payload with optional detail fields"
```

---

### Task 4 : Migration `0007_enrich_core_clubs.sql`

**Files:**
- Create: `db/migrations/0007_enrich_core_clubs.sql`

- [ ] **Step 4.1 : Écrire la migration**

```sql
-- 0007_enrich_core_clubs.sql
-- Enrichissement de core.clubs avec les champs détail extraits des fiches club.
-- Idempotent : utilise ADD COLUMN IF NOT EXISTS.

ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS telephone               text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS email                   text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS site_web                text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS adresse_correspondance  text;
ALTER TABLE core.clubs ADD COLUMN IF NOT EXISTS effectif_estime         integer;
-- salle_principale_id existe déjà depuis la migration 0003, rien à ajouter ici.
```

Si l'exploration a révélé d'autres champs (logo URL, date de fondation, président…), les ajouter ici en suivant le même pattern.

- [ ] **Step 4.2 : Appliquer la migration**

Run:
```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball < db/migrations/0007_enrich_core_clubs.sql
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.clubs" | grep -E "telephone|email|site_web|adresse_correspondance|effectif_estime"
```
Expected : 5 lignes (une par colonne ajoutée).

- [ ] **Step 4.3 : Commit**

```bash
git add db/migrations/0007_enrich_core_clubs.sql
git commit -m "feat(db): enrich core.clubs with detail fields"
```

---

## Phase 3 — Scraper fiche détail (TDD)

### Task 5 : Test scraper — cas `complet`

**Files:**
- Create: `tests/scrapers/club-details.scraper.test.ts`

- [ ] **Step 5.1 : Écrire le premier test (cas riche)**

```ts
// tests/scrapers/club-details.scraper.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClubDetail } from "@/scrapers/ffhandball/club-details.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const SOURCE_URL = "https://www.ffhandball.fr/clubs/6275001";

describe("parseClubDetail — fixture complet", () => {
  it("extrait le payload club enrichi", () => {
    const html = fixture("ffhandball-club-detail-complet.html");
    const result = parseClubDetail(html, SOURCE_URL);
    expect(result).not.toBeNull();
    expect(result!.club.id_ffhb).toMatch(/^\d+$/);
    expect(result!.club.nom).toBeTruthy();
    expect(result!.club.source_url).toBe(SOURCE_URL);
    // Au moins un des champs enrichis doit être présent
    expect(
      result!.club.telephone ||
        result!.club.email ||
        result!.club.site_web ||
        result!.club.salle_principale_id_ffhb,
    ).toBeTruthy();
  });

  it("extrait le payload salle quand présent", () => {
    const html = fixture("ffhandball-club-detail-complet.html");
    const result = parseClubDetail(html, SOURCE_URL);
    expect(result!.salle).not.toBeNull();
    expect(result!.salle!.nom).toBeTruthy();
    expect(result!.salle!.source_url).toBe(SOURCE_URL);
    expect(result!.salle!.source_club_id_ffhb).toBe(result!.club.id_ffhb);
  });
});
```

- [ ] **Step 5.2 : Lancer le test, attendre l'échec**

Run: `npm test -- club-details.scraper`
Expected : FAIL — `parseClubDetail` n'existe pas (`Cannot find module`).

- [ ] **Step 5.3 : Implémenter le scraper minimal**

Créer `src/scrapers/ffhandball/club-details.scraper.ts` :

```ts
import * as cheerio from "cheerio";
import { rawClubPayloadSchema, type RawClubPayload } from "@/schemas/club.schema.js";
import { rawSallePayloadSchema, type RawSallePayload } from "@/schemas/salle.schema.js";

export interface ClubDetailResult {
  club: RawClubPayload;
  salle: RawSallePayload | null;
}

/**
 * Parse une fiche détail club ffhandball.fr.
 *
 * Sélecteurs et fallbacks sont issus de `docs/club-detail-fields.md` (Task 1).
 * Retourne null si le HTML ne contient pas les éléments minimaux d'une fiche
 * (id_ffhb + nom). Erreurs partielles (champ optionnel manquant) → champ undefined.
 */
export function parseClubDetail(
  html: string,
  sourceUrl: string,
): ClubDetailResult | null {
  const $ = cheerio.load(html);

  // ---- Bloc club ------------------------------------------------------
  // ⚠️ Les sélecteurs ci-dessous sont à AJUSTER selon docs/club-detail-fields.md.
  const id_ffhb = ($("[data-club-id]").attr("data-club-id") ?? "").trim();
  const nom = $("h1.club-name").text().trim().replace(/\s+/g, " ");
  if (!id_ffhb || !nom) return null;

  const ville = $(".club-ville").text().trim() || undefined;
  const dept = $(".club-dept").text().trim() || undefined;
  const telephone = $(".contact-phone").text().trim() || undefined;
  const email = $(".contact-email").text().trim() || undefined;
  const site_web = $(".contact-web a").attr("href")?.trim() || undefined;
  const adresse_correspondance =
    $(".adresse-correspondance").text().trim() || undefined;

  // ---- Bloc salle -----------------------------------------------------
  const $salleBloc = $(".salle").first();
  let salle: RawSallePayload | null = null;

  if ($salleBloc.length > 0) {
    const salle_nom = $salleBloc.find(".nom").text().trim();
    if (salle_nom) {
      const exposedId = $salleBloc.attr("data-id")?.trim();
      const salle_adresse = $salleBloc.find(".adresse").text().trim() || undefined;
      const salle_cp = $salleBloc.find(".cp").text().trim() || undefined;
      const salle_ville = $salleBloc.find(".ville").text().trim() || undefined;
      const salle_dept = $salleBloc.find(".dept").text().trim() || undefined;

      const sallePayload = {
        id_ffhb: exposedId || slugSalle(salle_nom, salle_cp, salle_ville),
        nom: salle_nom,
        adresse: salle_adresse,
        code_postal: salle_cp,
        ville: salle_ville,
        departement_code: salle_dept,
        source_url: sourceUrl,
        source_club_id_ffhb: id_ffhb,
      };
      const parsedSalle = rawSallePayloadSchema.safeParse(sallePayload);
      if (parsedSalle.success) {
        salle = parsedSalle.data;
      }
    }
  }

  const clubCandidate = {
    id_ffhb,
    nom,
    ville,
    departement_code: dept,
    source_url: sourceUrl,
    telephone,
    email,
    site_web,
    adresse_correspondance,
    salle_principale_id_ffhb: salle?.id_ffhb,
  };
  const parsedClub = rawClubPayloadSchema.safeParse(clubCandidate);
  if (!parsedClub.success) return null;

  return { club: parsedClub.data, salle };
}

/** Slug déterministe pour fallback de natural_key. */
function slugSalle(
  nom: string,
  cp: string | undefined,
  ville: string | undefined,
): string {
  return [nom, cp ?? "", ville ?? ""]
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritiques (range Unicode "Combining Marks")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
```

**Note critique :** les sélecteurs CSS (`h1.club-name`, `.salle`, `.contact-phone`, etc.) ne sont **valides que si Task 1 les a confirmés**. Si l'inventaire montre des sélecteurs différents (`#club-header h1`, `[itemprop=name]`…), remplacer dans le code ci-dessus avant de lancer les tests.

- [ ] **Step 5.4 : Lancer le test, attendre PASS**

Run: `npm test -- club-details.scraper`
Expected : 2 tests PASS sur le cas `complet`.

Si FAIL, ajuster les sélecteurs en regardant le HTML de `ffhandball-club-detail-complet.html` jusqu'à PASS.

- [ ] **Step 5.5 : Commit**

```bash
git add src/scrapers/ffhandball/club-details.scraper.ts tests/scrapers/club-details.scraper.test.ts
git commit -m "feat(scrapers): parse club detail pages from ffhandball.fr"
```

---

### Task 6 : Tests scraper — cas `minimal` et `sans-salle`

**Files:**
- Modify: `tests/scrapers/club-details.scraper.test.ts`

- [ ] **Step 6.1 : Ajouter les tests des deux autres fixtures**

Ajouter à la fin de `tests/scrapers/club-details.scraper.test.ts` :

```ts
describe("parseClubDetail — fixture minimal", () => {
  it("retourne le club sans les champs enrichis manquants", () => {
    const html = fixture("ffhandball-club-detail-minimal.html");
    const result = parseClubDetail(html, SOURCE_URL);
    expect(result).not.toBeNull();
    expect(result!.club.id_ffhb).toBeTruthy();
    expect(result!.club.nom).toBeTruthy();
    expect(result!.club.telephone).toBeUndefined();
    expect(result!.club.email).toBeUndefined();
  });
});

describe("parseClubDetail — fixture sans-salle", () => {
  it("retourne salle = null quand le bloc salle est absent", () => {
    const html = fixture("ffhandball-club-detail-sans-salle.html");
    const result = parseClubDetail(html, SOURCE_URL);
    expect(result).not.toBeNull();
    expect(result!.salle).toBeNull();
    expect(result!.club.salle_principale_id_ffhb).toBeUndefined();
  });
});

describe("parseClubDetail — HTML invalide", () => {
  it("retourne null si pas de nom ni d'id détectable", () => {
    expect(parseClubDetail("<html><body>empty</body></html>", SOURCE_URL)).toBeNull();
  });
});
```

- [ ] **Step 6.2 : Lancer les tests**

Run: `npm test -- club-details.scraper`
Expected : 5 tests PASS au total (2 complet + 1 minimal + 1 sans-salle + 1 invalide).

Si FAIL sur `minimal` ou `sans-salle` → vérifier que les sélecteurs gèrent bien l'absence d'éléments (jQuery-style : `.text()` sur set vide retourne `""`, ce qui devient `undefined` via `|| undefined`).

- [ ] **Step 6.3 : Commit**

```bash
git add tests/scrapers/club-details.scraper.test.ts
git commit -m "test(scrapers): cover minimal and sans-salle club detail cases"
```

---

## Phase 4 — Intégration CLI `scrape`

### Task 7 : Étendre `src/cli/scrape.ts` pour `--entity=club-details`

**Files:**
- Modify: `src/cli/scrape.ts`

- [ ] **Step 7.1 : Ajouter les options `--limit` et `--id-ffhb`**

Dans `src/cli/scrape.ts`, remplacer la fonction `parseCliArgs` :

```ts
interface CliArgs {
  entity: string;
  saison: string;
  url?: string;
  limit?: number;
  idFfhb?: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
      url: { type: "string" },
      limit: { type: "string" },
      "id-ffhb": { type: "string" },
    },
  });
  if (!values.entity) throw new Error("--entity required");
  if (!values.saison) throw new Error("--saison required");
  return {
    entity: values.entity,
    saison: canonicalizeSaison(values.saison),
    url: values.url,
    limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
    idFfhb: values["id-ffhb"],
  };
}
```

- [ ] **Step 7.2 : Ajouter la fonction `scrapeClubDetails`**

Dans le même fichier, ajouter après `scrapeClubs` :

```ts
import { parseClubDetail } from "@/scrapers/ffhandball/club-details.scraper.js";
import { query } from "@/db/client.js";

async function scrapeClubDetails(
  saison: string,
  opts: { limit?: number; idFfhb?: string },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "ffhandball.fr",
    scraper_name: "club-details",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting club-details scrape");

  // Sélection des clubs à visiter
  let targets: Array<{ id_ffhb: string }>;
  if (opts.idFfhb) {
    targets = [{ id_ffhb: opts.idFfhb }];
  } else {
    const res = await query<{ id_ffhb: string }>(
      `SELECT id_ffhb FROM core.clubs ORDER BY id_ffhb${opts.limit ? " LIMIT $1" : ""}`,
      opts.limit ? [opts.limit] : [],
    );
    targets = res.rows;
  }
  logger.info({ count: targets.length }, "targets selected");

  let inserted_clubs = 0;
  let inserted_salles = 0;
  let no_salle = 0;
  let parse_failed = 0;

  try {
    for (const { id_ffhb } of targets) {
      const url = `https://www.ffhandball.fr/clubs/${id_ffhb}`;
      const res = await fetchHtml(url);
      await run.incrementPages(1);

      const parsed = parseClubDetail(res.body, res.url);
      if (!parsed) {
        parse_failed++;
        logger.warn({ id_ffhb, url }, "parseClubDetail returned null");
        continue;
      }

      // Insert payload club enrichi (nouvelle version dans raw.clubs)
      await insertRaw("clubs", {
        scrape_run_id: run.id,
        source_url: parsed.club.source_url,
        source_site: "ffhandball.fr",
        natural_key: parsed.club.id_ffhb,
        payload: parsed.club,
        saison,
        http_status: res.status,
      });
      inserted_clubs++;

      // Insert payload salle si présent
      if (parsed.salle) {
        await insertRaw("salles", {
          scrape_run_id: run.id,
          source_url: parsed.salle.source_url,
          source_site: "ffhandball.fr",
          natural_key: parsed.salle.id_ffhb,
          payload: parsed.salle,
          saison,
          http_status: res.status,
        });
        inserted_salles++;
      } else {
        no_salle++;
      }
    }
    logger.info({ inserted_clubs, inserted_salles, no_salle, parse_failed }, "done");
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "club-details scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}
```

- [ ] **Step 7.3 : Brancher la nouvelle entité dans `main`**

Remplacer la fonction `main()` :

```ts
async function main(): Promise<void> {
  const args = parseCliArgs();
  if (args.entity === "clubs") {
    const url = args.url ?? "https://www.ffhandball.fr/clubs";
    await scrapeClubs(args.saison, url);
  } else if (args.entity === "club-details") {
    await scrapeClubDetails(args.saison, { limit: args.limit, idFfhb: args.idFfhb });
  } else {
    throw new Error(`unknown entity: ${args.entity}`);
  }
}
```

- [ ] **Step 7.4 : Typecheck**

Run: `npm run typecheck`
Expected : exits 0.

- [ ] **Step 7.5 : Smoke test (un seul club, fetch réel)**

⚠️ **Pré-requis :** un `id_ffhb` valide existe dans `core.clubs`. Si la DB locale est vide, lancer d'abord un `npm run scrape -- --entity=clubs ...` pour peupler.

Run :
```bash
npm run scrape -- --entity=club-details --saison=2025-2026 --id-ffhb=<un_id_réel>
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "
  SELECT count(*) FROM raw.clubs WHERE saison='2025-2026' AND scrape_run_id IN
    (SELECT id FROM raw.scrape_runs WHERE scraper_name='club-details');
"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "
  SELECT count(*) FROM raw.salles;
"
```
Expected : `inserted_clubs=1`, et `count(raw.salles) >= 0` (0 si le club n'a pas de salle, 1 sinon).

Si le smoke test renvoie `parse_failed=1` → les sélecteurs sont incorrects pour ce club spécifique → améliorer le scraper et relancer.

- [ ] **Step 7.6 : Commit**

```bash
git add src/cli/scrape.ts
git commit -m "feat(cli): scrape command supports --entity=club-details"
```

---

## Phase 5 — ETL salles (TDD)

### Task 8 : Test ETL salles — cas nominal

**Files:**
- Create: `tests/etl/salles.etl.test.ts`

- [ ] **Step 8.1 : Écrire le test**

```ts
// tests/etl/salles.etl.test.ts
import { afterAll, beforeEach, describe, it, expect } from "vitest";
import { query, closePool } from "@/db/client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runSallesEtl } from "@/etl/salles.etl.js";

const SAISON = "2025-2026";
const SALLE_IDS = ["TEST-SALLE-A", "TEST-SALLE-B", "TEST-SALLE-BADDEPT"];

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM core.etl_warnings WHERE natural_key = ANY($1::text[])`,
    [SALLE_IDS],
  );
  await query(
    `DELETE FROM core.etl_rejets WHERE natural_key = ANY($1::text[])`,
    [SALLE_IDS],
  );
  await query(`DELETE FROM core.salles WHERE id_ffhb = ANY($1::text[])`, [SALLE_IDS]);
  await query(
    `DELETE FROM raw.salles WHERE natural_key = ANY($1::text[]) AND saison = $2`,
    [SALLE_IDS, SAISON],
  );
  await query(
    `DELETE FROM raw.scrape_runs
       WHERE scraper_name = 'club-details' AND saison = $1
         AND id NOT IN (SELECT scrape_run_id FROM raw.salles)
         AND id NOT IN (SELECT scrape_run_id FROM raw.clubs)`,
    [SAISON],
  );
}

async function seedRawSalle(
  scrape_run_id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await insertRaw("salles", {
    scrape_run_id,
    source_url: "https://www.ffhandball.fr/clubs/9999999",
    source_site: "ffhandball.fr",
    natural_key: payload.id_ffhb as string,
    payload,
    saison: SAISON,
    http_status: 200,
  });
}

describe("salles ETL", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it("insère une salle valide en core.salles", async () => {
    const run = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await seedRawSalle(run.id, {
      id_ffhb: "TEST-SALLE-A",
      nom: "Gymnase Léo Lagrange",
      adresse: "12 rue du Stade",
      code_postal: "75001",
      ville: "Paris",
      departement_code: "75",
      source_url: "https://www.ffhandball.fr/clubs/9999999",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const report = await runSallesEtl(SAISON);
    expect(report.rows_read).toBe(1);
    expect(report.rows_validated).toBe(1);
    expect(report.rows_inserted).toBe(1);

    const r = await query<{ nom: string; ville: string; departement_id: number | null }>(
      `SELECT nom, ville, departement_id FROM core.salles WHERE id_ffhb = $1`,
      ["TEST-SALLE-A"],
    );
    expect(r.rows[0]!.nom).toBe("Gymnase Léo Lagrange");
    expect(r.rows[0]!.ville).toBe("Paris");
    expect(r.rows[0]!.departement_id).not.toBeNull();
  });
});
```

- [ ] **Step 8.2 : Lancer le test, attendre l'échec**

Run: `npm test -- salles.etl`
Expected : FAIL — `runSallesEtl` n'existe pas.

- [ ] **Step 8.3 : Implémenter `src/etl/salles.etl.ts`**

```ts
import { query } from "@/db/client.js";
import { rawSallePayloadSchema, type RawSallePayload } from "@/schemas/salle.schema.js";
import { titleCaseFr, normalizeText } from "@/etl/shared/normalize-text.js";
import { resolveDepartementId } from "@/etl/shared/resolve-fk.js";
import { logger } from "@/lib/logger.js";

interface RawSalleRow {
  id: number;
  natural_key: string;
  payload: unknown;
}

interface EtlReport {
  etl_run_id: number;
  rows_read: number;
  rows_validated: number;
  rows_rejected: number;
  rows_inserted: number;
  rows_updated: number;
  rows_noop: number;
  warnings_count: number;
}

export async function runSallesEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('salles', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report = {
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
    const rawRows = await query<RawSalleRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.salles
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawSallePayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets
             (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'salles',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawSallePayload = parsed.data;
      const nom = titleCaseFr(p.nom);
      const ville = p.ville ? titleCaseFr(p.ville) : null;
      const adresse = p.adresse ? normalizeText(p.adresse) : null;
      const cp = p.code_postal ?? null;
      const cap = p.capacite ?? null;
      const dept_id = await resolveDepartementId(p.departement_code);
      if (p.departement_code && dept_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1, 'salles', $2, $3)`,
          [etl_run_id, p.id_ffhb, `dept ${p.departement_code} introuvable`],
        );
        report.warnings_count++;
      }

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.salles
           (id_ffhb, nom, adresse, code_postal, ville, departement_id, capacite, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom = EXCLUDED.nom,
             adresse = EXCLUDED.adresse,
             code_postal = EXCLUDED.code_postal,
             ville = EXCLUDED.ville,
             departement_id = EXCLUDED.departement_id,
             capacite = EXCLUDED.capacite,
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.salles.nom IS DISTINCT FROM EXCLUDED.nom
                 OR core.salles.adresse IS DISTINCT FROM EXCLUDED.adresse
                 OR core.salles.code_postal IS DISTINCT FROM EXCLUDED.code_postal
                 OR core.salles.ville IS DISTINCT FROM EXCLUDED.ville
                 OR core.salles.departement_id IS DISTINCT FROM EXCLUDED.departement_id
                 OR core.salles.capacite IS DISTINCT FROM EXCLUDED.capacite
               THEN now()
               ELSE core.salles.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.id_ffhb, nom, adresse, cp, ville, dept_id, cap],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(),
             status = 'success',
             rows_read = $2,
             rows_validated = $3,
             rows_rejected = $4,
             rows_inserted = $5,
             rows_updated = $6,
             rows_noop = $7,
             warnings_count = $8
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

    logger.info(report, "salles ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'failed', error_message = $2
         WHERE id = $1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
```

- [ ] **Step 8.4 : Lancer le test, attendre PASS**

Run: `npm test -- salles.etl`
Expected : 1 test PASS.

- [ ] **Step 8.5 : Commit**

```bash
git add src/etl/salles.etl.ts tests/etl/salles.etl.test.ts
git commit -m "feat(etl): salles ETL from raw to core, with FK resolution"
```

---

### Task 9 : Tests ETL salles — rejet, warning, idempotence

**Files:**
- Modify: `tests/etl/salles.etl.test.ts`

- [ ] **Step 9.1 : Ajouter trois tests**

Ajouter à la fin du fichier de test (avant la fermeture du `describe`) — ou créer un nouveau `describe` :

```ts
describe("salles ETL — cas dégradés", () => {
  beforeEach(cleanup);

  it("rejette un payload Zod-invalide", async () => {
    const run = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    // Pas de `nom` → Zod fail
    await seedRawSalle(run.id, {
      id_ffhb: "TEST-SALLE-B",
      // nom: missing
      source_url: "https://www.ffhandball.fr/clubs/9999999",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const report = await runSallesEtl(SAISON);
    expect(report.rows_rejected).toBe(1);
    expect(report.rows_inserted).toBe(0);

    const rej = await query<{ reason: string }>(
      `SELECT reason FROM core.etl_rejets WHERE natural_key = $1 ORDER BY id DESC LIMIT 1`,
      ["TEST-SALLE-B"],
    );
    expect(rej.rows[0]!.reason).toContain("nom");
  });

  it("loggue un warning quand le département est introuvable", async () => {
    const run = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await seedRawSalle(run.id, {
      id_ffhb: "TEST-SALLE-BADDEPT",
      nom: "Salle Inconnue",
      departement_code: "999", // n'existe pas
      source_url: "https://www.ffhandball.fr/clubs/9999999",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const report = await runSallesEtl(SAISON);
    expect(report.warnings_count).toBe(1);
    expect(report.rows_inserted).toBe(1);

    const r = await query<{ departement_id: number | null }>(
      `SELECT departement_id FROM core.salles WHERE id_ffhb = $1`,
      ["TEST-SALLE-BADDEPT"],
    );
    expect(r.rows[0]!.departement_id).toBeNull();
  });

  it("est idempotent — un second run ne réinsère rien", async () => {
    const run = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await seedRawSalle(run.id, {
      id_ffhb: "TEST-SALLE-A",
      nom: "Gymnase Léo Lagrange",
      code_postal: "75001",
      ville: "Paris",
      departement_code: "75",
      source_url: "https://www.ffhandball.fr/clubs/9999999",
      source_club_id_ffhb: "9999999",
    });
    await run.finishSuccess();

    const r1 = await runSallesEtl(SAISON);
    expect(r1.rows_inserted).toBe(1);

    const r2 = await runSallesEtl(SAISON);
    expect(r2.rows_read).toBe(1);
    expect(r2.rows_inserted).toBe(0);
    expect(r2.rows_updated).toBe(0);
    expect(r2.rows_noop).toBe(1);
  });
});
```

- [ ] **Step 9.2 : Lancer tous les tests salles**

Run: `npm test -- salles.etl`
Expected : 4 tests PASS au total.

- [ ] **Step 9.3 : Commit**

```bash
git add tests/etl/salles.etl.test.ts
git commit -m "test(etl): salles ETL rejets, warnings, idempotency"
```

---

## Phase 6 — Étendre `clubs.etl.ts`

### Task 10 : Mapper les nouveaux champs + résoudre `salle_principale_id`

**Files:**
- Modify: `src/etl/clubs.etl.ts`

- [ ] **Step 10.1 : Étendre l'UPSERT pour les nouveaux champs**

Dans `src/etl/clubs.etl.ts`, dans la boucle `for (const row of rawRows.rows)`, **après** le calcul de `ligue_id` et **avant** le `const upsert = await query(...)`, ajouter la résolution de la salle :

```ts
      let salle_principale_id: number | null = null;
      if (p.salle_principale_id_ffhb) {
        const sRes = await query<{ id: number }>(
          `SELECT id FROM core.salles WHERE id_ffhb = $1 LIMIT 1`,
          [p.salle_principale_id_ffhb],
        );
        salle_principale_id = sRes.rows[0]?.id ?? null;
        if (salle_principale_id === null) {
          await query(
            `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
             VALUES ($1, 'clubs', $2, $3)`,
            [
              etl_run_id,
              p.id_ffhb,
              `salle ${p.salle_principale_id_ffhb} introuvable, FK non résolue`,
            ],
          );
          report.warnings_count++;
        }
      }
```

Puis remplacer le bloc `INSERT INTO core.clubs ... ON CONFLICT` pour inclure les nouveaux champs :

```ts
      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.clubs (
           id_ffhb, nom, ville, departement_id, ligue_id, salle_principale_id,
           telephone, email, site_web, adresse_correspondance, effectif_estime,
           last_seen_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom = EXCLUDED.nom,
             ville = EXCLUDED.ville,
             departement_id = EXCLUDED.departement_id,
             ligue_id = EXCLUDED.ligue_id,
             salle_principale_id = COALESCE(EXCLUDED.salle_principale_id, core.clubs.salle_principale_id),
             telephone = COALESCE(EXCLUDED.telephone, core.clubs.telephone),
             email = COALESCE(EXCLUDED.email, core.clubs.email),
             site_web = COALESCE(EXCLUDED.site_web, core.clubs.site_web),
             adresse_correspondance = COALESCE(EXCLUDED.adresse_correspondance, core.clubs.adresse_correspondance),
             effectif_estime = COALESCE(EXCLUDED.effectif_estime, core.clubs.effectif_estime),
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.clubs.nom IS DISTINCT FROM EXCLUDED.nom
                 OR core.clubs.ville IS DISTINCT FROM EXCLUDED.ville
                 OR core.clubs.departement_id IS DISTINCT FROM EXCLUDED.departement_id
                 OR core.clubs.ligue_id IS DISTINCT FROM EXCLUDED.ligue_id
                 OR (EXCLUDED.salle_principale_id IS NOT NULL
                     AND core.clubs.salle_principale_id IS DISTINCT FROM EXCLUDED.salle_principale_id)
                 OR (EXCLUDED.telephone IS NOT NULL
                     AND core.clubs.telephone IS DISTINCT FROM EXCLUDED.telephone)
                 OR (EXCLUDED.email IS NOT NULL
                     AND core.clubs.email IS DISTINCT FROM EXCLUDED.email)
                 OR (EXCLUDED.site_web IS NOT NULL
                     AND core.clubs.site_web IS DISTINCT FROM EXCLUDED.site_web)
                 OR (EXCLUDED.adresse_correspondance IS NOT NULL
                     AND core.clubs.adresse_correspondance IS DISTINCT FROM EXCLUDED.adresse_correspondance)
                 OR (EXCLUDED.effectif_estime IS NOT NULL
                     AND core.clubs.effectif_estime IS DISTINCT FROM EXCLUDED.effectif_estime)
               THEN now()
               ELSE core.clubs.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [
          p.id_ffhb,
          nom,
          ville,
          dept_id,
          ligue_id,
          salle_principale_id,
          p.telephone ?? null,
          p.email ?? null,
          p.site_web ?? null,
          p.adresse_correspondance ?? null,
          p.effectif_estime ?? null,
        ],
      );
```

**Note clé :** le `COALESCE(EXCLUDED.x, core.clubs.x)` protège les enrichissements déjà acquis lorsqu'un re-run consomme à nouveau le payload listing passe 1 (où ces champs sont NULL).

- [ ] **Step 10.2 : Typecheck**

Run: `npm run typecheck`
Expected : exits 0.

- [ ] **Step 10.3 : Lancer les tests existants de l'ETL clubs**

Run: `npm test -- clubs-end-to-end`
Expected : le test du pilote clubs PASS (les nouveaux champs sont optionnels et NULL pour les payloads passe 1 → l'UPSERT enrichi les ignore via COALESCE).

Si FAIL : examiner l'erreur. Probable cause : `effectif_estime` typé `integer` qui reçoit `null` — déjà géré dans le `VALUES` via `?? null`.

- [ ] **Step 10.4 : Commit**

```bash
git add src/etl/clubs.etl.ts
git commit -m "feat(etl): clubs ETL maps detail fields and resolves salle_principale_id"
```

---

## Phase 7 — CLI `etl --entity=salles`

### Task 11 : Brancher `runSallesEtl` dans le CLI

**Files:**
- Modify: `src/cli/etl.ts`

- [ ] **Step 11.1 : Importer et dispatcher**

Remplacer le contenu de `src/cli/etl.ts` par :

```ts
import { parseArgs } from "node:util";
import { logger } from "@/lib/logger.js";
import { closePool } from "@/db/client.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";
import { runSallesEtl } from "@/etl/salles.etl.js";

interface CliArgs {
  entity: string;
  saison: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
    },
  });
  if (!values.entity) throw new Error("--entity required");
  if (!values.saison) throw new Error("--saison required");
  return { entity: values.entity, saison: canonicalizeSaison(values.saison) };
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  let report;
  if (args.entity === "clubs") {
    report = await runClubsEtl(args.saison);
  } else if (args.entity === "salles") {
    report = await runSallesEtl(args.saison);
  } else {
    throw new Error(`unknown entity: ${args.entity}`);
  }
  logger.info(report, "etl finished");
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    logger.fatal({ err }, "fatal");
    await closePool();
    process.exit(1);
  });
```

- [ ] **Step 11.2 : Typecheck**

Run: `npm run typecheck`
Expected : exits 0.

- [ ] **Step 11.3 : Smoke test CLI salles**

⚠️ Pré-requis : au moins une row dans `raw.salles` (produite par le smoke test de la Task 7.5).

Run :
```bash
npm run etl -- --entity=salles --saison=2025-2026
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "
  SELECT id_ffhb, nom, departement_id FROM core.salles LIMIT 5;
"
```
Expected : la ligne ETL run apparaît dans les logs avec `rows_inserted >= 1` ou `rows_noop >= 1`.

- [ ] **Step 11.4 : Commit**

```bash
git add src/cli/etl.ts
git commit -m "feat(cli): etl command supports --entity=salles"
```

---

## Phase 8 — Test d'intégration end-to-end

### Task 12 : Test bout-en-bout club-details + ETL chaînés

**Files:**
- Create: `tests/integration/club-details-end-to-end.test.ts`

- [ ] **Step 12.1 : Écrire le test d'intégration**

```ts
// tests/integration/club-details-end-to-end.test.ts
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { query, closePool } from "@/db/client.js";
import { startScrapeRun } from "@/scrapers/shared/scrape-run.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { parseClubDetail } from "@/scrapers/ffhandball/club-details.scraper.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";
import { runSallesEtl } from "@/etl/salles.etl.js";

const SAISON = "2025-2026";
const FIXTURE_COMPLET = fileURLToPath(
  new URL("../fixtures/ffhandball-club-detail-complet.html", import.meta.url),
);

async function cleanup(clubId: string, salleId: string | null): Promise<void> {
  const clubIds = [clubId];
  const salleIds = salleId ? [salleId] : [];
  await query(`DELETE FROM core.etl_warnings WHERE natural_key = ANY($1::text[])`,
    [[...clubIds, ...salleIds]]);
  await query(`DELETE FROM core.etl_rejets WHERE natural_key = ANY($1::text[])`,
    [[...clubIds, ...salleIds]]);
  if (salleIds.length > 0) {
    await query(`UPDATE core.clubs SET salle_principale_id = NULL WHERE id_ffhb = ANY($1::text[])`,
      [clubIds]);
    await query(`DELETE FROM core.salles WHERE id_ffhb = ANY($1::text[])`, [salleIds]);
    await query(`DELETE FROM raw.salles WHERE natural_key = ANY($1::text[]) AND saison = $2`,
      [salleIds, SAISON]);
  }
  await query(`DELETE FROM core.clubs WHERE id_ffhb = ANY($1::text[])`, [clubIds]);
  await query(`DELETE FROM raw.clubs WHERE natural_key = ANY($1::text[]) AND saison = $2`,
    [clubIds, SAISON]);
  await query(
    `DELETE FROM raw.scrape_runs
       WHERE scraper_name = 'club-details' AND saison = $1
         AND id NOT IN (SELECT scrape_run_id FROM raw.clubs)
         AND id NOT IN (SELECT scrape_run_id FROM raw.salles)`,
    [SAISON],
  );
}

describe("club-details end-to-end", () => {
  let clubId: string;
  let salleId: string | null;

  beforeAll(async () => {
    // Parse la fixture pour récupérer les IDs réels (peuvent varier selon la fixture observée)
    const html = readFileSync(FIXTURE_COMPLET, "utf8");
    const parsed = parseClubDetail(html, "https://www.ffhandball.fr/clubs/X");
    if (!parsed) throw new Error("fixture complet n'est pas parsable — corriger la fixture ou le scraper");
    clubId = parsed.club.id_ffhb;
    salleId = parsed.salle?.id_ffhb ?? null;
    await cleanup(clubId, salleId);
  });

  afterAll(async () => {
    await cleanup(clubId, salleId);
    await closePool();
  });

  it("scrape fixture → raw.clubs+raw.salles → etl salles → etl clubs → core.clubs.salle_principale_id résolu", async () => {
    const html = readFileSync(FIXTURE_COMPLET, "utf8");
    const sourceUrl = `https://www.ffhandball.fr/clubs/${clubId}`;
    const parsed = parseClubDetail(html, sourceUrl);
    expect(parsed).not.toBeNull();
    expect(parsed!.salle).not.toBeNull();

    // Étape 1 : émulation du scrape — insert raw via la même mécanique que le CLI
    const run = await startScrapeRun({
      source_site: "ffhandball.fr",
      scraper_name: "club-details",
      saison: SAISON,
    });
    await insertRaw("clubs", {
      scrape_run_id: run.id,
      source_url: sourceUrl,
      source_site: "ffhandball.fr",
      natural_key: parsed!.club.id_ffhb,
      payload: parsed!.club,
      saison: SAISON,
      http_status: 200,
    });
    await insertRaw("salles", {
      scrape_run_id: run.id,
      source_url: sourceUrl,
      source_site: "ffhandball.fr",
      natural_key: parsed!.salle!.id_ffhb,
      payload: parsed!.salle!,
      saison: SAISON,
      http_status: 200,
    });
    await run.finishSuccess();

    // Étape 2 : ETL salles d'abord (sinon la FK ne peut pas se résoudre)
    const rs = await runSallesEtl(SAISON);
    expect(rs.rows_inserted).toBeGreaterThanOrEqual(1);

    // Étape 3 : ETL clubs après — résout salle_principale_id
    const rc = await runClubsEtl(SAISON);
    expect(rc.rows_validated).toBeGreaterThanOrEqual(1);

    // Vérification
    const r = await query<{ salle_principale_id: number | null; telephone: string | null }>(
      `SELECT salle_principale_id, telephone FROM core.clubs WHERE id_ffhb = $1`,
      [clubId],
    );
    expect(r.rows[0]!.salle_principale_id).not.toBeNull();
    // telephone peut être null si la fixture n'en expose pas — on ne l'assert pas strict
  });

  it("re-run complet est idempotent", async () => {
    // Le seed est déjà fait par le test précédent
    const rs2 = await runSallesEtl(SAISON);
    const rc2 = await runClubsEtl(SAISON);
    expect(rs2.rows_inserted).toBe(0);
    expect(rs2.rows_updated).toBe(0);
    expect(rc2.rows_inserted).toBe(0);
    // updated peut être 0 ou >0 selon si le second ETL clubs détecte un diff
    expect(rc2.rows_rejected).toBe(0);
  });
});
```

- [ ] **Step 12.2 : Lancer le test**

Run: `npm test -- club-details-end-to-end`
Expected : 2 tests PASS.

Si FAIL avec "fixture complet n'est pas parsable" → revenir corriger les sélecteurs dans `club-details.scraper.ts` jusqu'à ce que la fixture complet produise un `parsed` non-null avec une salle.

- [ ] **Step 12.3 : Commit**

```bash
git add tests/integration/club-details-end-to-end.test.ts
git commit -m "test: end-to-end club-details scrape → raw → ETLs → core, idempotent"
```

---

## Phase 9 — Documentation

### Task 13 : Mettre à jour le runbook

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 13.1 : Ajouter une section "Enrichir les clubs avec salles"**

Ajouter à la fin de `docs/runbook.md` :

````markdown
## Enrichir les clubs avec leur salle (passe 2)

Pré-requis : `core.clubs` est déjà peuplé via la passe 1 (`npm run scrape -- --entity=clubs`).

### Scrape des fiches détail

```bash
# Test dev sur 1 club
npm run scrape -- --entity=club-details --saison=2025-2026 --id-ffhb=<id>

# Validation sur 50 clubs
npm run scrape -- --entity=club-details --saison=2025-2026 --limit=50

# Run complet (~2000 clubs, ~50 min à 1.5 s/req — préférer en nocturne)
npm run scrape -- --entity=club-details --saison=2025-2026
```

### ETL dans l'ordre

```bash
npm run etl -- --entity=salles --saison=2025-2026
npm run etl -- --entity=clubs  --saison=2025-2026
```

**Important :** `salles` avant `clubs`. Sinon `clubs.salle_principale_id` reste NULL
et un warning est créé pour chaque club. Un re-run de `clubs` après `salles`
résout les FKs manquantes.

### Suivre la couverture

```sql
-- % de clubs avec salle principale résolue
SELECT
  count(*)                                                        AS total,
  count(salle_principale_id)                                      AS with_salle,
  round(100.0 * count(salle_principale_id) / count(*), 1)         AS pct
FROM core.clubs;

-- Warnings de la dernière session ETL
SELECT entity, natural_key, message
  FROM core.etl_warnings
  WHERE etl_run_id = (SELECT max(id) FROM core.etl_runs);

-- Salles sans département résolu
SELECT id_ffhb, nom, ville FROM core.salles WHERE departement_id IS NULL;
```

### Rejouer après bug de nettoyage

```sql
-- Reset salles uniquement
UPDATE core.clubs SET salle_principale_id = NULL;
TRUNCATE core.salles CASCADE;
```

Puis ré-exécuter les deux ETL. `raw.salles` et `raw.clubs` sont intacts.
````

- [ ] **Step 13.2 : Commit**

```bash
git add docs/runbook.md
git commit -m "docs: runbook section for clubs+salles enrichment pass"
```

---

## Vérification finale

- [ ] **Lancer la suite de tests complète**

Run: `npm test`
Expected : tous les tests PASS — pilote clubs + nouveaux tests scraper, ETL salles, intégration club-details.

- [ ] **Lancer le typecheck**

Run: `npm run typecheck`
Expected : exits 0.

- [ ] **Vérifier l'état DB**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='core' AND table_name='clubs'
     AND column_name IN ('telephone','email','site_web','adresse_correspondance','effectif_estime')
  ) AS new_columns,
  (SELECT count(*) FROM raw.salles)  AS raw_salles_rows,
  (SELECT count(*) FROM core.salles) AS core_salles_rows;
"
```
Expected : `new_columns = 5`, et après un run de smoke test : `raw_salles_rows >= 1`, `core_salles_rows >= 1`.

---

## Next steps (hors-scope de ce plan)

- Programmer le scrape `club-details` en cron nocturne (ex. dimanche 03:00)
- Ajouter la métrique de couverture (`pct clubs avec salle`) à un dashboard / log mensuel
- Passer à l'entité suivante selon l'ordre de la spec pilote :
  `competitions` + `poules` (dépend de saisons, déjà seed).
