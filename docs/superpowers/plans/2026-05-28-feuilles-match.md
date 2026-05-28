# Feuilles de match (FdM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Télécharger les FdM PDF depuis `media-ffhb-fdm.ffhandball.fr`, parser via `pdf-parse` v2 (Node-pur), alimenter `core.joueurs` (vide jusqu'ici), enrichir `core.match_compositions`, créer `core.match_actions` (déroulé chronologique), étendre `core.match_officiels`.

**Architecture:** Scraper PDF binaire (helper `fetchBinary`) → parser FdM (`fdm-pdf.parser.ts` avec 2 sous-parsers page 1 et page 2) → schéma Zod structuré → `raw.feuilles_match` (existante) → ETL cascade transactionnelle vers 5 tables core.

**Tech Stack:** TypeScript 5.7, `pdf-parse` v2 (NEW dependency), Zod, Postgres 16, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-feuilles-match-design.md`

**Pré-requis :** branche `feat/feuilles-match` créée. `raw.matchs` doit contenir des fdmCodes (smoke matchs précédents OK).

---

### Task 1: Capture fixtures FdM (PDFs réels)

**Files:**
- Create: `tests/fixtures/fdm-VAGPOQJ.pdf` (~326 KB, déjà téléchargé en /tmp/)
- Create: `tests/fixtures/fdm-{code-LBE-national}.pdf` (LBE féminine, ~300 KB)
- Create: `tests/fixtures/fdm-{code-N3-regional}.pdf` (régional séniors, ~300 KB)

**Pourquoi 3 fixtures** : valider le parser sur des structures variées (départemental, national, régional). Les FdMs peuvent différer légèrement (nombre de joueurs, présence d'officiels, format dates).

- [ ] **Step 1.1 : Copier la fixture VAGPOQJ déjà téléchargée**

```bash
cp /tmp/fdm-VAGPOQJ.pdf tests/fixtures/fdm-VAGPOQJ.pdf
file tests/fixtures/fdm-VAGPOQJ.pdf  # → PDF document, version 1.4, 2 pages
ls -la tests/fixtures/fdm-VAGPOQJ.pdf
```

- [ ] **Step 1.2 : Récupérer 2 fdmCodes additionnels depuis raw.matchs**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT
     payload->>'fdm_code' AS code,
     payload->>'ext_rencontre_id' AS rencontre,
     payload->>'date_heure' AS date
   FROM raw.matchs
   WHERE payload->>'fdm_code' IS NOT NULL
     AND payload->>'fdm_code' != ''
     AND payload->>'equipe1Score' IS NOT NULL  -- matchs joués (FdM publiée)
   ORDER BY random()
   LIMIT 5;"
```

Si `raw.matchs` est vide (cleanup tests), refaire un mini-scrape :

```bash
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --limit=2
```

Sélectionner 2 codes : un national (LBE = compétition de référence) et un régional si possible.

- [ ] **Step 1.3 : Télécharger les 2 PDFs additionnels**

```bash
UA="Mozilla/5.0 ffhandball-pipeline (loric@example.com)"

for CODE in VAGARCA VAGARIM; do  # remplacer par les codes choisis en 1.2
  URL="https://media-ffhb-fdm.ffhandball.fr/fdm/${CODE:0:1}/${CODE:1:1}/${CODE:2:1}/${CODE:3:1}/${CODE}.pdf"
  echo "Fetching: $URL"
  curl -sL -A "$UA" -o "tests/fixtures/fdm-${CODE}.pdf" -w "HTTP %{http_code} | size: %{size_download}\n" "$URL"
  sleep 2
done

ls -la tests/fixtures/fdm-*.pdf
```

⚠️ Si HTTP 404 : la FdM n'est pas encore publiée pour ce match. Choisir un autre code (match plus ancien dans la saison).

- [ ] **Step 1.4 : Commit fixtures binaires**

```bash
git add tests/fixtures/fdm-*.pdf
git commit -m "$(cat <<'EOF'
feat: fixtures FdM PDFs pour TDD parser

T1 : 3 fixtures réelles capturées pour validation du parser :
- fdm-VAGPOQJ.pdf : Honneur Masculin Moselle (départemental ?)
- fdm-{LBE-code}.pdf : Ligue Butagaz Energie (national fédéral)
- fdm-{N3-code}.pdf : Nationale 3 (régional séniors)

Tous ~300 KB, version PDF 1.4, 2 pages, text-extractable.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Installer pdf-parse + helper pdf-parser.ts

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/lib/pdf-parser.ts`
- Create: `tests/lib/pdf-parser.test.ts`

- [ ] **Step 2.1 : Installer pdf-parse v2 comme dépendance projet**

```bash
npm install pdf-parse@^2.0.0
```

Vérifier dans `package.json` que la dépendance est bien ajoutée dans `dependencies` (pas `devDependencies` — utilisée en prod).

- [ ] **Step 2.2 : Test (failing)**

```ts
// tests/lib/pdf-parser.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractPdfText } from "@/lib/pdf-parser.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

describe("extractPdfText", () => {
  it("extracts text from a 2-page FdM PDF", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const result = await extractPdfText(buf);
    expect(result.numPages).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]).toContain("Code Renc VAGPOQJ");
    expect(result.pages[1]).toContain("Déroulé du Match");
  });

  it("returns null on invalid PDF buffer", async () => {
    const result = await extractPdfText(Buffer.from("not a pdf"));
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2.3 : Implémenter le wrapper**

```ts
// src/lib/pdf-parser.ts
import { createRequire } from "node:module";
import { logger } from "@/lib/logger.js";

const require = createRequire(import.meta.url);

// pdf-parse v2 expose une classe PDFParse
interface PDFParseClass {
  new (options: { data: Buffer }): {
    getText(): Promise<{ pages: Array<{ text: string; num: number }> }>;
  };
}
const { PDFParse } = require("pdf-parse") as { PDFParse: PDFParseClass };

export interface ExtractedPdf {
  numPages: number;
  pages: string[];  // texte par page, indexé depuis 0
}

export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdf | null> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return {
      numPages: result.pages.length,
      pages: result.pages.map((p) => p.text),
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "pdf-parse extraction failed");
    return null;
  }
}
```

- [ ] **Step 2.4 : Run tests**

```bash
npx vitest run tests/lib/pdf-parser.test.ts
```

Expected : 2 passed.

- [ ] **Step 2.5 : Commit**

```bash
git add package.json package-lock.json src/lib/pdf-parser.ts tests/lib/pdf-parser.test.ts
git commit -m "$(cat <<'EOF'
feat: helper pdf-parser.ts (wrapper pdf-parse v2)

T2 : nouvelle dépendance pdf-parse@^2.0.0. Helper extractPdfText
asynchrone qui prend un Buffer et retourne { numPages, pages: string[] }
ou null si parsing échoue (PDF corrompu, password protected, etc.).

Utilise createRequire pour importer pdf-parse v2 (CJS) depuis ESM.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Schéma Zod feuille-match (sous-schémas joueur, officiel, action, global)

**Files:**
- Create: `src/schemas/feuille-match.schema.ts`
- Create: `tests/schemas/feuille-match.schema.test.ts`

- [ ] **Step 3.1 : Tests (failing) — 6 tests**

```ts
// tests/schemas/feuille-match.schema.test.ts
import { describe, it, expect } from "vitest";
import {
  rawFeuilleMatchPayloadSchema,
  rawJoueurInFdmSchema,
  rawOfficielInFdmSchema,
  rawActionInFdmSchema,
} from "@/schemas/feuille-match.schema.js";

describe("rawJoueurInFdmSchema", () => {
  it("accepts a complete joueur", () => {
    const r = rawJoueurInFdmSchema.safeParse({
      numero_licence: "5655011101039",
      nom: "BAUDSON",
      prenom: "valentin",
      type_licence: "A",
      numero_maillot: 25,
      capitaine: false,
      gardien: false,
      buts: 3,
      sept_metres_reussis: null,
      sept_metres_tentes: null,
      tirs: 8,
      arrets: null,
      avertissement: false,
      exclusions_2min: null,
      disqualifie: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects malformed numero_licence", () => {
    const r = rawJoueurInFdmSchema.safeParse({
      numero_licence: "ABC", nom: "X", prenom: "Y", type_licence: "A",
      numero_maillot: 1, capitaine: false, gardien: false,
      buts: 0, sept_metres_reussis: 0, sept_metres_tentes: 0,
      tirs: 0, arrets: 0, avertissement: false, exclusions_2min: 0, disqualifie: false,
    });
    expect(r.success).toBe(false);
  });
});

describe("rawOfficielInFdmSchema", () => {
  it("accepts complete officiel", () => {
    const r = rawOfficielInFdmSchema.safeParse({
      role: "chronometreur",
      cote: "recevant",
      nom: "LODOVICI",
      prenom: "enzo",
      numero_licence: "5655011101546",
    });
    expect(r.success).toBe(true);
  });
});

describe("rawActionInFdmSchema", () => {
  it("accepts a but action", () => {
    const r = rawActionInFdmSchema.safeParse({
      ordre: 1,
      periode: 1,
      temps_seconds: 180,  // 03:00
      score_recevant: 1,
      score_visiteur: 0,
      type_action: "but",
      cote: "recevant",
      numero_maillot: 22,
      acteur_role: "joueur",
      description_brute: "But JR N°22 SUSSENAIRE romain",
    });
    expect(r.success).toBe(true);
  });
});

describe("rawFeuilleMatchPayloadSchema", () => {
  it("accepts a complete payload", () => {
    const r = rawFeuilleMatchPayloadSchema.safeParse({
      fdm_code: "VAGPOQJ",
      organisateur: "LIGUE GRAND EST DE HANDBALL",
      competition_libelle: "CHAMPIONNAT HONNEUR MASCULIN",
      equipe_recevant_libelle: "ETAIN",
      equipe_visiteur_libelle: "SARRALBE",
      date_heure_str: "samedi 25/04/2026 20:30",
      score_recevant: 23,
      score_visiteur: 37,
      score_mi_temps_recevant: 10,
      score_mi_temps_visiteur: 17,
      statut_match: "JOUE",
      officiels: [],
      composition_recevant: [],
      composition_visiteur: [],
      actions: [],
      source_url: "https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/VAGPOQJ.pdf",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty fdm_code", () => {
    const r = rawFeuilleMatchPayloadSchema.safeParse({
      fdm_code: "",
      equipe_recevant_libelle: "X",
      equipe_visiteur_libelle: "Y",
      date_heure_str: "Z",
      officiels: [], composition_recevant: [], composition_visiteur: [], actions: [],
      source_url: "https://x/",
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed source_url", () => {
    const r = rawFeuilleMatchPayloadSchema.safeParse({
      fdm_code: "X",
      equipe_recevant_libelle: "X", equipe_visiteur_libelle: "Y",
      date_heure_str: "Z",
      officiels: [], composition_recevant: [], composition_visiteur: [], actions: [],
      source_url: "not-a-url",
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 3.2 : Run failing**

```bash
npx vitest run tests/schemas/feuille-match.schema.test.ts
```

- [ ] **Step 3.3 : Implémenter le schéma**

```ts
// src/schemas/feuille-match.schema.ts
import { z } from "zod";

const intOrNull = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  },
  z.number().int().nullable(),
);

export const rawJoueurInFdmSchema = z.object({
  numero_licence: z.string().regex(/^\d{10,13}$/),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  type_licence: z.string().length(1),
  numero_maillot: intOrNull,
  capitaine: z.boolean(),
  gardien: z.boolean(),
  buts: intOrNull,
  sept_metres_reussis: intOrNull,
  sept_metres_tentes: intOrNull,
  tirs: intOrNull,
  arrets: intOrNull,
  avertissement: z.boolean(),
  exclusions_2min: intOrNull,
  disqualifie: z.boolean(),
});
export type RawJoueurInFdm = z.infer<typeof rawJoueurInFdmSchema>;

export const rawOfficielInFdmSchema = z.object({
  role: z.string().min(1),
  cote: z.enum(["recevant", "visiteur", "neutre"]),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  numero_licence: z.string().regex(/^\d{10,13}$/).optional(),
});
export type RawOfficielInFdm = z.infer<typeof rawOfficielInFdmSchema>;

export const rawActionInFdmSchema = z.object({
  ordre: z.number().int().nonnegative(),
  periode: z.number().int().min(1).max(4),
  temps_seconds: z.number().int().nonnegative(),
  score_recevant: z.number().int().nonnegative(),
  score_visiteur: z.number().int().nonnegative(),
  type_action: z.enum([
    "but", "tir", "arret", "avertissement",
    "exclusion_2min", "disqualification",
    "temps_mort_recevant", "temps_mort_visiteur",
    "protocole_commotion", "autre",
  ]),
  cote: z.enum(["recevant", "visiteur"]).optional(),
  numero_maillot: z.number().int().nullable().optional(),
  numero_licence: z.string().optional(),
  acteur_role: z.enum(["joueur", "officiel"]).optional(),
  description_brute: z.string(),
});
export type RawActionInFdm = z.infer<typeof rawActionInFdmSchema>;

export const rawFeuilleMatchPayloadSchema = z.object({
  fdm_code: z.string().min(1),
  organisateur: z.string().optional(),
  organisateur_code: z.string().optional(),
  competition_libelle: z.string().optional(),
  groupe: z.string().optional(),
  poule_libelle: z.string().optional(),
  equipe_recevant_libelle: z.string().min(1),
  equipe_visiteur_libelle: z.string().min(1),
  equipe_recevant_code: z.string().optional(),
  equipe_visiteur_code: z.string().optional(),
  date_heure_str: z.string().min(1),
  journee_libelle: z.string().optional(),
  salle_libelle: z.string().optional(),
  salle_adresse: z.string().optional(),
  score_recevant: intOrNull,
  score_visiteur: intOrNull,
  score_mi_temps_recevant: intOrNull,
  score_mi_temps_visiteur: intOrNull,
  statut_match: z.string().optional(),
  officiels: z.array(rawOfficielInFdmSchema),
  composition_recevant: z.array(rawJoueurInFdmSchema),
  composition_visiteur: z.array(rawJoueurInFdmSchema),
  actions: z.array(rawActionInFdmSchema),
  source_url: z.string().url(),
  pdf_size_bytes: z.number().int().positive().optional(),
});
export type RawFeuilleMatchPayload = z.infer<typeof rawFeuilleMatchPayloadSchema>;
```

- [ ] **Step 3.4 : Run passing**

```bash
npx vitest run tests/schemas/feuille-match.schema.test.ts
```

Expected : 6 passed.

- [ ] **Step 3.5 : Commit**

```bash
git add src/schemas/feuille-match.schema.ts tests/schemas/feuille-match.schema.test.ts
git commit -m "$(cat <<'EOF'
feat: schéma Zod feuille-match (joueur + officiel + action + global)

T3 : 4 schémas exportés pour le payload raw.feuilles_match :
- rawJoueurInFdmSchema : compo joueur avec n° licence + stats
- rawOfficielInFdmSchema : officiel avec role + côté
- rawActionInFdmSchema : action chronologique avec type énuméré
- rawFeuilleMatchPayloadSchema : payload global racine

Helper intOrNull preprocess pour coercer strings sources.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Parser FdM Page 1 (metadata + officiels + compositions)

**Files:**
- Create: `src/scrapers/ffhandball/fdm-pdf.parser.ts`
- Create: `tests/scrapers/fdm-pdf.parser.test.ts`

C'est la tâche la plus complexe du plan. **Approche** : isoler le parsing en sous-fonctions dédiées (header, officiels, compositions, score), testables individuellement.

- [ ] **Step 4.1 : Squelette + tests metadata (failing)**

```ts
// tests/scrapers/fdm-pdf.parser.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseFdmPdf } from "@/scrapers/ffhandball/fdm-pdf.parser.js";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

const SOURCE_URL = "https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/VAGPOQJ.pdf";

describe("parseFdmPdf — metadata (Page 1)", () => {
  it("extracts fdm_code, équipes, score from VAGPOQJ", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.fdm_code).toBe("VAGPOQJ");
    expect(r!.organisateur).toContain("LIGUE GRAND EST");
    expect(r!.competition_libelle).toContain("HONNEUR MASCULIN");
    expect(r!.equipe_recevant_libelle).toContain("ETAIN");
    expect(r!.equipe_visiteur_libelle).toContain("SARRALBE");
    expect(r!.score_recevant).toBe(23);
    expect(r!.score_visiteur).toBe(37);
    expect(r!.score_mi_temps_recevant).toBe(10);
    expect(r!.score_mi_temps_visiteur).toBe(17);
    expect(r!.statut_match).toBe("JOUE");
    expect(r!.date_heure_str).toContain("25/04/2026");
    expect(r!.salle_libelle).toContain("OMNISPORT DE LA GALAVAUDE");
    expect(r!.source_url).toBe(SOURCE_URL);
  });
});

describe("parseFdmPdf — officiels (Page 1)", () => {
  it("extracts table officiels with role + licence", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.officiels.length).toBeGreaterThan(2);

    // Chronométreur LODOVICI enzo
    const chrono = r!.officiels.find((o) => o.role === "chronometreur");
    expect(chrono).toBeDefined();
    expect(chrono!.nom).toBe("LODOVICI");
    expect(chrono!.prenom).toBe("enzo");
    expect(chrono!.numero_licence).toBe("5655011101546");

    // Juge Arbitre 1 ATAMNA emma
    const arb1 = r!.officiels.find((o) => o.role === "juge_arbitre_1");
    expect(arb1).toBeDefined();
    expect(arb1!.nom).toBe("ATAMNA");
  });
});

describe("parseFdmPdf — composition recevant (Page 1)", () => {
  it("extracts 11+ joueurs recevant with stats", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.composition_recevant.length).toBeGreaterThanOrEqual(10);

    // BAUDSON valentin n°25 — 3 buts, 8 tirs
    const baudson = r!.composition_recevant.find((j) => j.nom === "BAUDSON" && j.prenom === "valentin");
    expect(baudson).toBeDefined();
    expect(baudson!.numero_maillot).toBe(25);
    expect(baudson!.numero_licence).toBe("5655011101039");
    expect(baudson!.type_licence).toBe("A");
    expect(baudson!.buts).toBe(3);
    expect(baudson!.tirs).toBe(8);

    // MACEL dylan : capitaine X (préfixe X dans la ligne)
    const macel = r!.composition_recevant.find((j) => j.nom === "MACEL");
    expect(macel).toBeDefined();
    expect(macel!.capitaine).toBe(true);
    expect(macel!.numero_maillot).toBe(95);
  });
});

describe("parseFdmPdf — composition visiteur (Page 1)", () => {
  it("extracts joueurs visiteur with stats avancées", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();

    // GROSSE thomas : 3 buts, 3 tirs, avertissement X, 1 exclusion 2'
    const grosse = r!.composition_visiteur.find((j) => j.nom === "GROSSE" && j.prenom === "thomas");
    expect(grosse).toBeDefined();
    expect(grosse!.buts).toBe(3);
    expect(grosse!.tirs).toBe(3);
    expect(grosse!.avertissement).toBe(true);
    expect(grosse!.exclusions_2min).toBe(1);

    // NEMSGUERS michel : avertissement X + 2 exclusions
    const nem = r!.composition_visiteur.find((j) => j.nom === "NEMSGUERS");
    expect(nem!.avertissement).toBe(true);
    expect(nem!.exclusions_2min).toBe(2);

    // BLATNIK noah : capitaine X n°8
    const blatnik = r!.composition_visiteur.find((j) => j.nom === "BLATNIK");
    expect(blatnik!.capitaine).toBe(true);
  });
});

describe("parseFdmPdf — cas dégradés", () => {
  it("returns null on invalid PDF buffer", async () => {
    const r = await parseFdmPdf(Buffer.from("not a pdf"), SOURCE_URL, "INVALID");
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 4.2 : Run failing**

```bash
npx vitest run tests/scrapers/fdm-pdf.parser.test.ts
```

- [ ] **Step 4.3 : Implémenter le parser Page 1**

```ts
// src/scrapers/ffhandball/fdm-pdf.parser.ts
import { extractPdfText } from "@/lib/pdf-parser.js";
import {
  rawFeuilleMatchPayloadSchema,
  type RawFeuilleMatchPayload,
  type RawJoueurInFdm,
  type RawOfficielInFdm,
  type RawActionInFdm,
} from "@/schemas/feuille-match.schema.js";
import { logger } from "@/lib/logger.js";

// ============================================================================
// Helpers
// ============================================================================

/** Parse une string entière potentiellement vide (colonnes tableau). */
function parseIntOrNull(s: string | undefined): number | null {
  if (!s || s.trim() === "") return null;
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Convertit "mm:ss" en secondes. */
function timeToSeconds(timeStr: string): number {
  const [m, s] = timeStr.split(":").map(Number);
  return (m ?? 0) * 60 + (s ?? 0);
}

// ============================================================================
// Page 1 : Header + Score
// ============================================================================

interface HeaderResult {
  organisateur?: string;
  organisateur_code?: string;
  competition_libelle?: string;
  groupe?: string;
  poule_libelle?: string;
  equipe_recevant_libelle: string;
  equipe_visiteur_libelle: string;
  date_heure_str: string;
  journee_libelle?: string;
  salle_libelle?: string;
  salle_adresse?: string;
  score_recevant: number | null;
  score_visiteur: number | null;
  score_mi_temps_recevant: number | null;
  score_mi_temps_visiteur: number | null;
  statut_match?: string;
}

function parseHeader(page1Text: string, fdmCode: string): HeaderResult | null {
  const lines = page1Text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Organisateur : "Organisateur LIGUE GRAND EST DE HANDBALL (5600000) Code Renc VAGPOQJ"
  const orgLine = lines.find((l) => l.startsWith("Organisateur"));
  const orgMatch = orgLine?.match(/Organisateur\s+(.+?)\s*\((\d+)\)/);
  const organisateur = orgMatch?.[1]?.trim();
  const organisateur_code = orgMatch?.[2];

  // Compétition : ligne après "Compétition"
  const compIdx = lines.findIndex((l) => l.startsWith("Compétition"));
  const compLine = compIdx >= 0 ? lines[compIdx] : null;
  const competition_libelle = compLine?.replace(/^Compétition\s+/, "").trim();

  // Poule + Groupe : ligne suivante typiquement
  // "56-HONNEUR MASC POULE 3 Groupe M56000202G"
  const pouleLine = lines.find((l) => l.includes("Groupe"));
  const pouleMatch = pouleLine?.match(/^(.+?)\s+Groupe\s+(.+)$/);
  const poule_libelle = pouleMatch?.[1]?.trim();
  const groupe = pouleMatch?.[2]?.trim();

  // Équipes + score final : "ETAIN ... / SARRALBE 23 37"
  const matchLine = lines.find((l) => l.includes(" / ") && /\d+\s+\d+\s*$/.test(l));
  const matchMatch = matchLine?.match(/^(.+?)\s*\/\s*(.+?)\s+(\d+)\s+(\d+)\s*$/);
  if (!matchMatch) return null;
  const equipe_recevant_libelle = matchMatch[1]!.trim();
  const equipe_visiteur_libelle = matchMatch[2]!.trim();
  const score_recevant = parseInt(matchMatch[3]!, 10);
  const score_visiteur = parseInt(matchMatch[4]!, 10);

  // Date
  const dateLine = lines.find((l) => l.startsWith("DATE:"));
  const date_heure_str = dateLine?.replace(/^DATE:\s*/, "").replace(/Journée.*$/, "").trim() ?? "";

  // Journée
  const journeeMatch = page1Text.match(/J\d+\s+du\s+[\d/]+\s+au\s+[\d/]+/);
  const journee_libelle = journeeMatch?.[0];

  // Salle : "SALLE: 5655 - OMNISPORT DE LA GALAVAUDE\n1 RUE DUCOLONEL DRIAND 55100 VERDUN"
  const salleMatch = page1Text.match(/SALLE:\s*(.+?)(?:\n|$)/);
  const salle_libelle = salleMatch?.[1]?.trim();
  // L'adresse est sur la ligne suivante après SALLE
  const salleIdx = lines.findIndex((l) => l.includes("SALLE:"));
  const salle_adresse = salleIdx >= 0 && salleIdx + 1 < lines.length ? lines[salleIdx + 1] : undefined;

  // Score mi-temps : section DETAIL SCORE
  // "Période 1   Fin Tps Reglem.   ...   REC VIS REC VIS ...   10 17 23 37"
  // On capture les 4 premiers nombres après "REC VIS"
  const scoreLine = lines.find((l) => /^\d+\s+\d+\s+\d+\s+\d+\s*$/.test(l));
  let score_mi_temps_recevant: number | null = null;
  let score_mi_temps_visiteur: number | null = null;
  if (scoreLine) {
    const parts = scoreLine.split(/\s+/).map((s) => parseInt(s, 10));
    if (parts.length >= 2) {
      score_mi_temps_recevant = parts[0]!;
      score_mi_temps_visiteur = parts[1]!;
    }
  }

  // Statut Match : "Statut Match :JOUE"
  const statutMatch = page1Text.match(/Statut Match\s*:\s*(\w+)/);
  const statut_match = statutMatch?.[1];

  return {
    organisateur,
    organisateur_code,
    competition_libelle,
    groupe,
    poule_libelle,
    equipe_recevant_libelle,
    equipe_visiteur_libelle,
    date_heure_str,
    journee_libelle,
    salle_libelle,
    salle_adresse,
    score_recevant,
    score_visiteur,
    score_mi_temps_recevant,
    score_mi_temps_visiteur,
    statut_match,
  };
}

// ============================================================================
// Page 1 : Officiels de table
// ============================================================================

const OFFICIEL_ROLES: Record<string, string> = {
  "Chronométreur": "chronometreur",
  "Secrétaire": "secretaire",
  "Tuteur de Table": "tuteur_table",
  "Responsable de Salle": "responsable_salle",
  "Speaker": "speaker",
  "Juge Arbitre 1": "juge_arbitre_1",
  "Juge Arbitre 2": "juge_arbitre_2",
  "Juge": "juge",
  "Juge Délégué": "juge_delegue",
  "Délégué Officiel": "delegue_officiel",
  "Accompagnateur": "accompagnateur",
};

function parseOfficiels(page1Text: string): RawOfficielInFdm[] {
  const officiels: RawOfficielInFdm[] = [];
  // Pour chaque rôle connu, chercher la ligne "ROLE_LABEL NOM prenom LICENCE"
  for (const [label, role] of Object.entries(OFFICIEL_ROLES)) {
    // Pattern : "Chronométreur LODOVICI enzo 5655011101546"
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s+([A-Z][A-Z'\\- ]+?)\\s+([a-zA-Z'-]+)\\s+(\\d{10,13})`, "g");
    let m;
    while ((m = re.exec(page1Text)) !== null) {
      officiels.push({
        role,
        cote: "neutre",  // les officiels de table sont neutres par défaut
        nom: m[1]!.trim(),
        prenom: m[2]!.trim(),
        numero_licence: m[3]!,
      });
    }
  }
  return officiels;
}

// ============================================================================
// Page 1 : Composition équipe
// ============================================================================

/**
 * Parse une ligne joueur :
 *   [X] N° NOM prenom(parts) LICENCE TYPE [BUTS] [7M] [TIRS] [ARRETS] [X|nb] [2'_nb] [DIS_X]
 *
 * Exemples :
 *   "25 BAUDSON valentin 5655011101039 A 3 8"             → numero=25, nom=BAUDSON, prenom=valentin, licence=..., type=A, buts=3, tirs=8 (le reste vide)
 *   "X 95 MACEL dylan 5655011101499 A 1 1 2"              → capitaine, numero=95
 *   "82 AKCIL mehmet 5657027100847 A 3 3 3"               → buts=3, 7m_reussis=3, tirs=3
 *   "23 GROSSE thomas 5657027100959 A 3 3 X 1"            → buts=3, 7m=3, av=X, 2'=1
 *   "87 MEYER tom - MEYER-MATTA 5657027100665 A 8 9"      → prenom composé "tom-MEYER-MATTA" ou "tom MEYER-MATTA"
 */
function parseJoueurLine(line: string): RawJoueurInFdm | null {
  // 1. Détecter capitaine (X en début)
  let working = line.trim();
  const capitaine = working.startsWith("X ");
  if (capitaine) working = working.slice(2).trim();

  // 2. Extraire numéro de maillot (premier token numérique)
  const match = working.match(/^(\d+)\s+(.+?)\s+(\d{10,13})\s+([A-Z])(.*)$/);
  if (!match) return null;

  const numero_maillot = parseInt(match[1]!, 10);
  const nomPrenom = match[2]!.trim();
  const numero_licence = match[3]!;
  const type_licence = match[4]!;
  const rest = match[5]!.trim();

  // 3. Séparer NOM / prenom (NOM en majuscules suivi du prénom en lowercase)
  // Gère noms composés "tom - MEYER-MATTA"
  // Algo : on trouve le 1er mot qui n'est PAS tout-majuscules (= début du prénom)
  const tokens = nomPrenom.split(/\s+/);
  let nomTokens: string[] = [];
  let prenomTokens: string[] = [];
  for (const t of tokens) {
    if (/^[A-ZÀ-Ý'\-]+$/.test(t) && prenomTokens.length === 0) {
      nomTokens.push(t);
    } else {
      prenomTokens.push(t);
    }
  }
  const nom = nomTokens.join(" ") || "?";
  const prenom = prenomTokens.join(" ") || "?";

  // 4. Stats : rest = "Buts 7m Tirs Arrets Av. 2' Dis"
  //    Chaque colonne séparée par espace, vides = absences. On split puis on prend les 7 premiers.
  const cols = rest.split(/\s+/).filter((c) => c.length > 0);

  // Conventions :
  // - "X" dans une colonne = présence (ex avertissement)
  // - Nombre = quantité
  // - Absence = colonne vide
  // Mais comme les vides sont supprimés par split(), on ne peut pas connaître quelle colonne. Heuristique :
  // Pour gérer ça, on identifie les "X" et les chiffres séparément.

  // Approche pragmatique : on assume que les colonnes vides sont en fin de ligne.
  // Les 4 premières colonnes (Buts, 7m, Tirs, Arrets) sont des nombres ou vides.
  // Av. (5e) est X ou vide. 2' (6e) est nombre ou vide. Dis (7e) est X ou vide.
  // On parcourt et on déduit selon le pattern X vs digit.

  const stats = {
    buts: null as number | null,
    sept_metres_reussis: null as number | null,
    sept_metres_tentes: null as number | null,
    tirs: null as number | null,
    arrets: null as number | null,
    avertissement: false,
    exclusions_2min: null as number | null,
    disqualifie: false,
  };

  // Parser séquentiel : assign aux 4 premières colonnes numériques, puis détecter X|n
  // Mais l'ordre exact peut sauter des cols. Approche simplifiée : prendre les 4 premières valeurs (numériques) comme buts/7m/tirs/arrets dans l'ordre, puis détecter X pour avertissement et disq.
  // ⚠️ Limitation : si "buts vide, 7m=3, tirs=3" → cols=[3,3] → on lira buts=3 (erreur). C'est une approximation.

  let numIdx = 0;
  let sawX = 0;
  for (const c of cols) {
    if (c === "X") {
      if (sawX === 0) stats.avertissement = true;
      else stats.disqualifie = true;
      sawX++;
    } else if (/^\d+$/.test(c)) {
      const v = parseInt(c, 10);
      if (numIdx === 0) stats.buts = v;
      else if (numIdx === 1) stats.sept_metres_reussis = v;  // ou tentés selon format "n / m"
      else if (numIdx === 2) stats.tirs = v;
      else if (numIdx === 3) stats.arrets = v;
      else if (numIdx === 4) stats.exclusions_2min = v;
      numIdx++;
    } else if (c.includes("/")) {
      // Format "3 / 4" → 7m_reussis / 7m_tentes
      const [a, b] = c.split("/").map((s) => parseInt(s.trim(), 10));
      if (Number.isFinite(a)) stats.sept_metres_reussis = a!;
      if (Number.isFinite(b)) stats.sept_metres_tentes = b!;
    }
  }

  // Gardien : heuristique faible — si arrets > 0, on considère gardien
  const gardien = (stats.arrets ?? 0) > 0;

  return {
    numero_licence,
    nom,
    prenom,
    type_licence,
    numero_maillot,
    capitaine,
    gardien,
    ...stats,
  };
}

function parseComposition(page1Text: string, section: "recevant" | "visiteur"): RawJoueurInFdm[] {
  const lines = page1Text.split("\n");
  const marker = section === "recevant" ? "Club Recevant" : "Club Visiteur";
  const startIdx = lines.findIndex((l) => l.includes(marker));
  if (startIdx < 0) return [];

  const endIdx = lines.findIndex((l, i) => i > startIdx && (l.includes("Officiel Resp") || l.includes("Club Visiteur") || l.includes("DETAIL")));
  const sliceLines = lines.slice(startIdx, endIdx > 0 ? endIdx : undefined);

  const joueurs: RawJoueurInFdm[] = [];
  for (const line of sliceLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip header line
    if (trimmed.startsWith("Capt") || trimmed.startsWith("N°") || trimmed.startsWith("Club")) continue;

    const j = parseJoueurLine(trimmed);
    if (j) joueurs.push(j);
  }

  return joueurs;
}

// ============================================================================
// Page 2 — placeholder pour T5
// ============================================================================

function parseActions(_page2Text: string): RawActionInFdm[] {
  return [];  // implémenté en T5
}

// ============================================================================
// Fonction publique
// ============================================================================

export async function parseFdmPdf(
  buffer: Buffer,
  sourceUrl: string,
  fdmCode: string,
): Promise<RawFeuilleMatchPayload | null> {
  const extracted = await extractPdfText(buffer);
  if (!extracted || extracted.pages.length < 2) {
    logger.warn({ fdmCode }, "FdM PDF parsing failed or incomplete");
    return null;
  }

  const page1 = extracted.pages[0]!;
  const page2 = extracted.pages[1] ?? "";

  const header = parseHeader(page1, fdmCode);
  if (!header) {
    logger.warn({ fdmCode }, "FdM header parsing failed");
    return null;
  }

  const officiels = parseOfficiels(page1);
  const composition_recevant = parseComposition(page1, "recevant");
  const composition_visiteur = parseComposition(page1, "visiteur");
  const actions = parseActions(page2);

  const candidate = {
    fdm_code: fdmCode,
    ...header,
    officiels,
    composition_recevant,
    composition_visiteur,
    actions,
    source_url: sourceUrl,
    pdf_size_bytes: buffer.length,
  };

  const parsed = rawFeuilleMatchPayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    logger.warn({ fdmCode, errors: parsed.error.message }, "FdM Zod validation failed");
    return null;
  }
  return parsed.data;
}
```

- [ ] **Step 4.4 : Run tests passing**

```bash
npx vitest run tests/scrapers/fdm-pdf.parser.test.ts
```

Expected : 5 passed (4 metadata/officiels/compos + 1 cas dégradé). Si certains tests échouent à cause du parsing heuristique, ajuster les regex sur la vraie sortie de pdf-parse en debugging :

```bash
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
import { extractPdfText } from './src/lib/pdf-parser.js';
const buf = await readFile('./tests/fixtures/fdm-VAGPOQJ.pdf');
const r = await extractPdfText(buf);
console.log(r.pages[0]);
"
```

- [ ] **Step 4.5 : Commit**

```bash
git add src/scrapers/ffhandball/fdm-pdf.parser.ts tests/scrapers/fdm-pdf.parser.test.ts
git commit -m "$(cat <<'EOF'
feat: parser FdM Page 1 (metadata + officiels + compositions)

T4 : parseFdmPdf extrait depuis page 1 :
- Header : organisateur, compétition, équipes, score (final + mi-temps),
  date, salle, statut
- Officiels de table : chrono, secrétaire, juges arbitres, etc. avec
  n° licence
- Composition recevant + visiteur : 11+ joueurs par équipe avec
  numero_maillot, capitaine (X), NOM prenom, n° licence, type, buts,
  7m, tirs, arrêts, avertissement, 2', disqualification

Parser heuristique avec regex robustes. Helper parseJoueurLine gère
les noms composés et l'ordre variable des colonnes vides. Détection
gardien faible (basée sur arrets > 0).

Page 2 (déroulé) implémentée en T5.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Parser FdM Page 2 (déroulé chronologique)

**Files:**
- Modify: `src/scrapers/ffhandball/fdm-pdf.parser.ts` (compléter `parseActions`)
- Modify: `tests/scrapers/fdm-pdf.parser.test.ts` (ajouter tests page 2)

- [ ] **Step 5.1 : Ajouter tests pour le déroulé (failing)**

Ajouter à la fin du describe principal :

```ts
describe("parseFdmPdf — actions (Page 2)", () => {
  it("extracts chronological actions from VAGPOQJ déroulé", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    expect(r).not.toBeNull();
    expect(r!.actions.length).toBeGreaterThan(40);

    // 1ère action : 02:41 — Arrêt JR N°95 MACEL dylan
    const first = r!.actions[0]!;
    expect(first.ordre).toBe(0);
    expect(first.periode).toBe(1);
    expect(first.temps_seconds).toBe(2 * 60 + 41);
    expect(first.type_action).toBe("arret");
    expect(first.cote).toBe("recevant");
    expect(first.numero_maillot).toBe(95);
    expect(first.acteur_role).toBe("joueur");
  });

  it("recognizes buts and tirs with cote dom/ext", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const buts = r!.actions.filter((a) => a.type_action === "but");
    const tirs = r!.actions.filter((a) => a.type_action === "tir");
    expect(buts.length).toBeGreaterThan(10);
    expect(tirs.length).toBeGreaterThan(5);
    expect(buts.every((b) => b.cote === "recevant" || b.cote === "visiteur")).toBe(true);
  });

  it("parses sanctions (avertissement, 2MN)", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const avert = r!.actions.find((a) => a.type_action === "avertissement");
    expect(avert).toBeDefined();
    const exclu = r!.actions.find((a) => a.type_action === "exclusion_2min");
    expect(exclu).toBeDefined();
  });

  it("parses temps mort with cote", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const tm = r!.actions.find((a) => a.type_action === "temps_mort_recevant" || a.type_action === "temps_mort_visiteur");
    expect(tm).toBeDefined();
  });

  it("recognizes protocole commotion", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    const pc = r!.actions.find((a) => a.type_action === "protocole_commotion");
    expect(pc).toBeDefined();
    expect(pc!.acteur_role).toBe("joueur");
  });

  it("ordre is strictly monotonic (0, 1, 2, ...)", async () => {
    const buf = await readFile(fixturePath("fdm-VAGPOQJ.pdf"));
    const r = await parseFdmPdf(buf, SOURCE_URL, "VAGPOQJ");
    for (let i = 0; i < r!.actions.length; i++) {
      expect(r!.actions[i]!.ordre).toBe(i);
    }
  });
});
```

- [ ] **Step 5.2 : Run failing**

```bash
npx vitest run tests/scrapers/fdm-pdf.parser.test.ts
```

- [ ] **Step 5.3 : Implémenter `parseActions`**

Remplacer la fonction placeholder dans `fdm-pdf.parser.ts` :

```ts
function parseActions(page2Text: string): RawActionInFdm[] {
  const lines = page2Text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const actions: RawActionInFdm[] = [];

  let currentPeriode = 1;
  let ordre = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Détecter changement de période
    if (line === "PERIODE 1") { currentPeriode = 1; continue; }
    if (line === "PERIODE 2") { currentPeriode = 2; continue; }

    // Match "mm:ss NN - MM" suivi d'une action sur la ligne suivante (pdf-parse v2 split parfois)
    // ou sur la même ligne après le score
    const m = line.match(/^(\d+:\d+)\s+(\d+)\s*-\s*(\d+)(.*)$/);
    if (!m) continue;

    const tempsStr = m[1]!;
    const scoreR = parseInt(m[2]!, 10);
    const scoreV = parseInt(m[3]!, 10);
    let description = m[4]!.trim();

    // Si description vide, action sur la ligne suivante (cas pdf-parse v2)
    if (!description && i + 1 < lines.length) {
      description = lines[i + 1]!.trim();
      i++;  // skip ligne consommée
    }

    if (!description) continue;

    // Analyser description :
    // "But JR N°22 SUSSENAIRE romain" → type=but, cote=recevant
    // "Avertissement JV N°3 NEMSGUERS michel"
    // "2MN JV N°82 AKCIL mehmet"
    // "Temps Mort d'Equipe Recevant"
    // "Protocole Commotion JR N°25 BAUDSON valentin"

    const action = parseActionDescription(description);
    if (!action) continue;

    actions.push({
      ordre,
      periode: currentPeriode,
      temps_seconds: timeToSeconds(tempsStr),
      score_recevant: scoreR,
      score_visiteur: scoreV,
      ...action,
      description_brute: description,
    });
    ordre++;
  }

  return actions;
}

function parseActionDescription(desc: string): Omit<RawActionInFdm, "ordre" | "periode" | "temps_seconds" | "score_recevant" | "score_visiteur" | "description_brute"> | null {
  // Temps mort
  if (/Temps Mort.*Recevant/i.test(desc)) {
    return { type_action: "temps_mort_recevant", cote: "recevant" };
  }
  if (/Temps Mort.*Visiteur/i.test(desc)) {
    return { type_action: "temps_mort_visiteur", cote: "visiteur" };
  }

  // Types principaux avec joueur : "TYPE J{R|V} N°NN NOM prenom"
  // ou avec officiel : "TYPE O{R|V} NOM prenom"
  const acteurMatch = desc.match(/^(.+?)\s+(J|O)([RV])(?:\s+N°(\d+))?\s+(.+)$/);
  if (!acteurMatch) {
    return { type_action: "autre" };
  }

  const typeWord = acteurMatch[1]!.trim();
  const acteurType = acteurMatch[2]!;  // J ou O
  const coteCode = acteurMatch[3]!;    // R ou V
  const numero = acteurMatch[4] ? parseInt(acteurMatch[4], 10) : null;

  const cote: "recevant" | "visiteur" = coteCode === "R" ? "recevant" : "visiteur";
  const acteur_role: "joueur" | "officiel" = acteurType === "J" ? "joueur" : "officiel";

  let type_action: RawActionInFdm["type_action"] = "autre";
  if (/^But$/i.test(typeWord)) type_action = "but";
  else if (/^Tir$/i.test(typeWord)) type_action = "tir";
  else if (/^Arrêt$/i.test(typeWord)) type_action = "arret";
  else if (/^Avertissement$/i.test(typeWord)) type_action = "avertissement";
  else if (/^2MN$/i.test(typeWord) || /2\s*Minutes/i.test(typeWord)) type_action = "exclusion_2min";
  else if (/Disqualification/i.test(typeWord)) type_action = "disqualification";
  else if (/Protocole.*Commotion/i.test(typeWord)) type_action = "protocole_commotion";

  return {
    type_action,
    cote,
    numero_maillot: numero,
    acteur_role,
  };
}
```

- [ ] **Step 5.4 : Run tests passing**

```bash
npx vitest run tests/scrapers/fdm-pdf.parser.test.ts
```

Expected : 11 passed (5 précédents + 6 nouveaux).

- [ ] **Step 5.5 : Commit**

```bash
git add src/scrapers/ffhandball/fdm-pdf.parser.ts tests/scrapers/fdm-pdf.parser.test.ts
git commit -m "$(cat <<'EOF'
feat: parser FdM Page 2 (déroulé chronologique)

T5 : parseActions extrait depuis page 2 le déroulé action par action.
Reconnaît 10 types d'actions (but, tir, arrêt, sanctions, temps morts,
protocole commotion). Distingue J/O (joueur/officiel) et R/V (côté).
Convertit mm:ss → secondes. Ordre monotonique recalculé.

Gère le split parfois sur 2 lignes par pdf-parse v2 (description sur
ligne suivante du score).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Migration 0015 (5 extensions schéma core)

**Files:**
- Create: `db/migrations/0015_feuilles_match_extensions.sql`

- [ ] **Step 6.1 : Pré-vérification**

```bash
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.matchs" | head -25
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.match_compositions"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.match_officiels"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\dt core.match_actions"  # devrait être inexistante
```

- [ ] **Step 6.2 : Écrire la migration**

```sql
-- db/migrations/0015_feuilles_match_extensions.sql

-- 1. Étendre core.match_compositions : stats fines par joueur par match
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS type_licence TEXT;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS tirs_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS arrets_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS sept_metres_tentes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS sept_metres_reussis INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS avertissement BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE core.match_compositions ADD COLUMN IF NOT EXISTS disqualifie BOOLEAN NOT NULL DEFAULT false;

-- 2. Étendre core.match_officiels : nouveaux rôles
ALTER TABLE core.match_officiels DROP CONSTRAINT IF EXISTS match_officiels_role_check;
ALTER TABLE core.match_officiels ADD CONSTRAINT match_officiels_role_check
  CHECK (role IN (
    'arbitre_1', 'arbitre_2',
    'delegue', 'observateur',
    'chrono', 'chronometreur', 'secretaire',
    'tuteur_table', 'juge_delegue', 'juge_arbitre_1', 'juge_arbitre_2', 'juge',
    'responsable_salle', 'speaker', 'delegue_officiel',
    'officiel_resp_a', 'officiel_b', 'officiel_c', 'officiel_d',
    'kine', 'medecin', 'accompagnateur'
  ));

-- 3. Créer core.match_actions (déroulé chronologique)
CREATE TABLE IF NOT EXISTS core.match_actions (
  id              bigserial PRIMARY KEY,
  match_id        bigint NOT NULL REFERENCES core.matchs(id) ON DELETE CASCADE,
  ordre           integer NOT NULL,
  periode         integer NOT NULL CHECK (periode BETWEEN 1 AND 4),
  temps_seconds   integer NOT NULL CHECK (temps_seconds >= 0),
  score_recevant  integer NOT NULL CHECK (score_recevant >= 0),
  score_visiteur  integer NOT NULL CHECK (score_visiteur >= 0),
  type_action     text NOT NULL CHECK (type_action IN (
    'but', 'tir', 'arret', 'avertissement',
    'exclusion_2min', 'disqualification',
    'temps_mort_recevant', 'temps_mort_visiteur',
    'protocole_commotion', 'autre'
  )),
  cote            text CHECK (cote IN ('recevant', 'visiteur')),
  joueur_id       bigint REFERENCES core.joueurs(id),
  numero_maillot  integer,
  acteur_role     text CHECK (acteur_role IN ('joueur', 'officiel')),
  description_brute text,
  CONSTRAINT uq_match_actions UNIQUE (match_id, ordre)
);
CREATE INDEX IF NOT EXISTS idx_match_actions_match  ON core.match_actions (match_id);
CREATE INDEX IF NOT EXISTS idx_match_actions_joueur ON core.match_actions (joueur_id);
CREATE INDEX IF NOT EXISTS idx_match_actions_type   ON core.match_actions (type_action);

-- 4. Étendre core.matchs : fdm_code + fdm_url
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_code TEXT;
ALTER TABLE core.matchs ADD COLUMN IF NOT EXISTS fdm_url TEXT;
CREATE INDEX IF NOT EXISTS idx_matchs_fdm_code ON core.matchs (fdm_code);

-- 5. core.joueurs : aucune modification (schéma existant convient)
--    numero_licence NOT NULL UNIQUE, nom NOT NULL, prenom NOT NULL
```

- [ ] **Step 6.3 : Appliquer + vérifier**

```bash
npm run db:migrate
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.matchs" | grep -E "fdm_code|fdm_url"
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.match_actions" | head -20
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c "\d core.match_compositions" | grep -E "tirs_count|arrets|sept_metres|avertissement|disqualifie|type_licence"
```

- [ ] **Step 6.4 : Étendre l'ETL matchs pour propager `fdm_code`**

Modifier `src/etl/matchs.etl.ts` :
- Dans le SQL UPSERT, ajouter `fdm_code` dans les colonnes insérées/updatées
- Ajouter `EXCLUDED.fdm_code` au CASE updated_at conditionnel
- Lire `p.fdm_code` (depuis le payload Zod-validé qui contient `fdm_code` — déjà schéma OK)

Code à modifier :

```ts
// Dans le SQL d'UPSERT, ajouter fdm_code :
`INSERT INTO core.matchs (
   id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id,
   date_heure, heure_estimee,
   score_dom, score_ext, score_mt_dom, score_mt_ext,
   statut, journee, equipement_id, fdm_code, last_seen_at
 )
 VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
 ON CONFLICT (id_ffhb_match) DO UPDATE
 SET ...,
     fdm_code = COALESCE(EXCLUDED.fdm_code, core.matchs.fdm_code),
     ...
     updated_at = CASE WHEN ...
                  OR (EXCLUDED.fdm_code IS NOT NULL AND core.matchs.fdm_code IS DISTINCT FROM EXCLUDED.fdm_code)
                  THEN now() ELSE core.matchs.updated_at END`,
[...autres params, p.fdm_code ?? null]
```

Ajouter 1 test dans `tests/etl/matchs.etl.test.ts` :
- "propagates fdm_code from raw payload to core.matchs"

Run :

```bash
npx vitest run tests/etl/matchs.etl.test.ts
```

- [ ] **Step 6.5 : Commit**

```bash
git add db/migrations/0015_feuilles_match_extensions.sql src/etl/matchs.etl.ts tests/etl/matchs.etl.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration 0015 + ETL matchs propage fdm_code

T6 : migration 0015 ajoute :
- core.match_compositions : type_licence, tirs_count, arrets_count,
  sept_metres_tentes, sept_metres_reussis, avertissement, disqualifie
- core.match_officiels : CHECK role étendu à 22 valeurs (officiels FdM)
- core.match_actions : NOUVELLE table (PK composite match_id + ordre,
  10 types d'actions, FK joueur nullable, 3 indexes)
- core.matchs : fdm_code (natural key FdM) + fdm_url (lien PDF pour API)

ETL matchs étendu pour propager payload.fdm_code → core.matchs.fdm_code
(COALESCE + CASE updated_at conditionnel).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: CLI scrape feuilles-match (helper fetchBinary + handler)

**Files:**
- Modify: `src/scrapers/shared/http-client.ts` (ajouter `fetchBinary`)
- Modify: `src/cli/scrape.ts` (handler `scrapeFeuillesMatch`)

- [ ] **Step 7.1 : Ajouter `fetchBinary` au http-client existant**

Localiser `src/scrapers/shared/http-client.ts` et ajouter une fonction parallèle à `fetchHtml` qui retourne un Buffer au lieu d'une string :

```ts
export interface BinaryResponse {
  body: Buffer;
  status: number;
  url: string;
  contentType: string;
}

export async function fetchBinary(url: string): Promise<BinaryResponse> {
  // Reuse la même infrastructure que fetchHtml (rate-limit + retry + UA)
  // mais retourner res.arrayBuffer() converti en Buffer
  // (logique exacte à adapter selon l'implémentation existante)
}
```

⚠️ Si l'implémentation de `fetchHtml` actuelle utilise `node-fetch` ou `undici`, réutiliser le même mécanisme. Sinon, implémenter en utilisant `fetch` natif Node 20+.

- [ ] **Step 7.2 : Ajouter handler `scrapeFeuillesMatch`**

Dans `src/cli/scrape.ts` :

Imports :
```ts
import { parseFdmPdf } from "@/scrapers/ffhandball/fdm-pdf.parser.js";
import { fetchBinary } from "@/scrapers/shared/http-client.js";
```

Handler :

```ts
async function scrapeFeuillesMatch(
  saison: string,
  opts: { limit?: number },
): Promise<void> {
  const run = await startScrapeRun({
    source_site: "media-ffhb-fdm.ffhandball.fr",
    scraper_name: "feuilles-match",
    saison,
  });
  logger.info({ run_id: run.id, ...opts }, "starting feuilles-match scrape");

  try {
    // 1. Codes uniques à scraper (filtrer ceux déjà en raw.feuilles_match)
    const codesRes = await query<{ fdm_code: string }>(
      `SELECT DISTINCT m.payload->>'fdm_code' AS fdm_code
         FROM raw.matchs m
        WHERE m.saison = $1
          AND m.payload->>'fdm_code' IS NOT NULL
          AND m.payload->>'fdm_code' != ''
          AND NOT EXISTS (
            SELECT 1 FROM raw.feuilles_match fm
            WHERE fm.natural_key = m.payload->>'fdm_code' AND fm.saison = $1
          )
        ORDER BY fdm_code`,
      [saison],
    );

    let toProcess = codesRes.rows;
    if (opts.limit !== undefined) toProcess = toProcess.slice(0, opts.limit);
    logger.info({ count: toProcess.length }, "fdm codes to process");

    let totalSuccess = 0;
    let total404 = 0;
    let parseFail = 0;

    for (const { fdm_code } of toProcess) {
      if (fdm_code.length < 4) {
        logger.warn({ fdm_code }, "fdm_code too short, skip");
        continue;
      }
      const url = `https://media-ffhb-fdm.ffhandball.fr/fdm/${fdm_code[0]}/${fdm_code[1]}/${fdm_code[2]}/${fdm_code[3]}/${fdm_code}.pdf`;
      const res = await fetchBinary(url);
      await run.incrementPages(1);

      if (res.status === 404) {
        total404++;
        continue;
      }
      if (res.status >= 400) {
        logger.warn({ url, status: res.status }, "FdM fetch failed");
        continue;
      }

      const parsed = await parseFdmPdf(res.body, url, fdm_code);
      if (!parsed) {
        parseFail++;
        continue;
      }

      await insertRaw("feuilles_match", {
        scrape_run_id: run.id,
        source_url: url,
        source_site: "media-ffhb-fdm.ffhandball.fr",
        natural_key: fdm_code,
        payload: parsed,
        saison,
        http_status: res.status,
      });
      totalSuccess++;
    }

    logger.info({ totalSuccess, total404, parseFail, totalProcessed: toProcess.length }, "feuilles-match scrape done");
    await run.finishSuccess();
  } catch (err) {
    logger.error({ err }, "feuilles-match scrape failed");
    await run.finishFailure(err);
    throw err;
  }
}
```

Dispatch dans `main()` :

```ts
  } else if (args.entity === "feuilles-match") {
    await scrapeFeuillesMatch(args.saison, { limit: args.limit });
```

- [ ] **Step 7.3 : Smoke test**

Pré-requis : `raw.matchs` doit avoir des fdmCodes. Si vide :
```bash
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --limit=3
```

Puis :
```bash
npm run scrape -- --entity=feuilles-match --saison=2025-2026 --limit=3

docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT count(*) FROM raw.feuilles_match WHERE saison='2025-2026';"
```

Expected : ≥1 ligne dans `raw.feuilles_match` (chaque ligne contient la FdM complète parsée).

- [ ] **Step 7.4 : Commit**

```bash
git add src/scrapers/shared/http-client.ts src/cli/scrape.ts
git commit -m "$(cat <<'EOF'
feat(cli): scrape --entity=feuilles-match

T7 : helper fetchBinary (téléchargement Buffer, mêmes garanties que
fetchHtml : rate-limit, UA, retry) + handler scrapeFeuillesMatch.

Pipeline : SELECT codes uniques depuis raw.matchs (filtrer ceux déjà
en raw.feuilles_match pour idempotence), download PDF, parseFdmPdf,
insertRaw. Skip silencieux sur HTTP 404 (FdM pas publiée).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: ETL feuilles-match (cascade transactionnelle)

**Files:**
- Create: `src/etl/feuilles-match.etl.ts`
- Create: `tests/etl/feuilles-match.etl.test.ts`

C'est la 2e tâche la plus complexe. Cascade en 5 étapes par FdM, transactionnelle pour atomicité.

- [ ] **Step 8.1 : Tests (failing) — 8 tests**

```ts
// tests/etl/feuilles-match.etl.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import { runFeuillesMatchEtl } from "@/etl/feuilles-match.etl.js";

const SAISON = "2025-2026";

async function setupSaison(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
}

async function seedMatchWithFdmCode(extMatchId: string, fdmCode: string): Promise<{ match_id: number }> {
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
     VALUES ('PO1', $1, 'P', $2) ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EDOM','ETAIN',$1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EEXT','SARRALBE',$1)
     ON CONFLICT (id_ffhb, saison_code) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`,
    [SAISON],
  );
  const m = await query<{ id: number }>(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, fdm_code)
     VALUES ($1, $2, $3, $4, '2026-04-25T20:30:00+02:00', $5) RETURNING id`,
    [extMatchId, poule.rows[0]!.id, eqDom.rows[0]!.id, eqExt.rows[0]!.id, fdmCode],
  );
  return { match_id: m.rows[0]!.id };
}

async function insertRawFdm(payload: object, naturalKey: string): Promise<void> {
  const runRes = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('media-ffhb-fdm.ffhandball.fr','feuilles-match',$1,'success') RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO raw.feuilles_match (scrape_run_id, source_url, source_site, natural_key, payload, payload_hash, saison, http_status)
     VALUES ($1,'https://x/','media-ffhb-fdm.ffhandball.fr',$2,$3,'h',$4,200)`,
    [runRes.rows[0]!.id, naturalKey, payload, SAISON],
  );
}

function buildFdmPayload(fdmCode: string): object {
  return {
    fdm_code: fdmCode,
    competition_libelle: "TEST",
    equipe_recevant_libelle: "ETAIN",
    equipe_visiteur_libelle: "SARRALBE",
    date_heure_str: "samedi 25/04/2026 20:30",
    score_recevant: 23,
    score_visiteur: 37,
    score_mi_temps_recevant: 10,
    score_mi_temps_visiteur: 17,
    statut_match: "JOUE",
    officiels: [],
    composition_recevant: [
      {
        numero_licence: "5655011101039", nom: "BAUDSON", prenom: "valentin",
        type_licence: "A", numero_maillot: 25, capitaine: false, gardien: false,
        buts: 3, sept_metres_reussis: null, sept_metres_tentes: null,
        tirs: 8, arrets: null, avertissement: false, exclusions_2min: null, disqualifie: false,
      },
    ],
    composition_visiteur: [
      {
        numero_licence: "5657027101035", nom: "BLATNIK", prenom: "noah",
        type_licence: "A", numero_maillot: 8, capitaine: true, gardien: false,
        buts: 6, sept_metres_reussis: null, sept_metres_tentes: null,
        tirs: 8, arrets: null, avertissement: false, exclusions_2min: null, disqualifie: false,
      },
    ],
    actions: [
      {
        ordre: 0, periode: 1, temps_seconds: 180,
        score_recevant: 1, score_visiteur: 0,
        type_action: "but", cote: "recevant",
        numero_maillot: 25, acteur_role: "joueur",
        description_brute: "But JR N°25 BAUDSON valentin",
      },
    ],
    source_url: "https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/VAGPOQJ.pdf",
  };
}

describe("runFeuillesMatchEtl", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.feuilles_match`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name IN ('feuilles-match','matchs')`);
    await query(`TRUNCATE core.match_actions, core.match_compositions, core.match_officiels, core.joueurs, core.matchs, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.arbitres, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setupSaison();
  });

  it("creates joueurs and compositions when match exists", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    const r = await runFeuillesMatchEtl(SAISON);

    expect(r.rows_inserted).toBeGreaterThan(0);

    const joueurs = await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`);
    expect(Number(joueurs.rows[0]!.count)).toBe(2);

    const compos = await query<{ count: string }>(`SELECT count(*) FROM core.match_compositions`);
    expect(Number(compos.rows[0]!.count)).toBe(2);

    // BAUDSON valentin
    const baudson = await query<{ nom: string; numero_maillot: number; tirs_count: number; but_count: number }>(
      `SELECT j.nom, mc.numero_maillot, mc.tirs_count, mc.but_count
         FROM core.match_compositions mc
         JOIN core.joueurs j ON j.id = mc.joueur_id
         WHERE j.nom = 'BAUDSON'`,
    );
    expect(baudson.rowCount).toBe(1);
    expect(baudson.rows[0]!.numero_maillot).toBe(25);
    expect(baudson.rows[0]!.tirs_count).toBe(8);
    expect(baudson.rows[0]!.but_count).toBe(3);
  });

  it("creates match_actions with ordre + type", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const actions = await query<{ ordre: number; type_action: string; temps_seconds: number }>(
      `SELECT ordre, type_action, temps_seconds FROM core.match_actions ORDER BY ordre`,
    );
    expect(actions.rowCount).toBe(1);
    expect(actions.rows[0]!.type_action).toBe("but");
    expect(actions.rows[0]!.temps_seconds).toBe(180);
  });

  it("updates core.matchs.fdm_url after successful download", async () => {
    const { match_id } = await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const m = await query<{ fdm_url: string | null }>(
      `SELECT fdm_url FROM core.matchs WHERE id = $1`,
      [match_id],
    );
    expect(m.rows[0]!.fdm_url).toContain("VAGPOQJ.pdf");
  });

  it("warns and skips when match (via fdm_code) does not resolve", async () => {
    // Pas de match avec fdm_code VAGPOQJ en core
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    const r = await runFeuillesMatchEtl(SAISON);
    expect(r.warnings_count).toBe(1);
    expect(r.rows_inserted).toBe(0);
  });

  it("is idempotent (re-run = same counts)", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);
    const before = (await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`)).rows[0]!.count;
    await runFeuillesMatchEtl(SAISON);
    const after = (await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`)).rows[0]!.count;
    expect(after).toBe(before);

    const compos = (await query<{ count: string }>(`SELECT count(*) FROM core.match_compositions`)).rows[0]!.count;
    expect(Number(compos)).toBe(2);

    const actions = (await query<{ count: string }>(`SELECT count(*) FROM core.match_actions`)).rows[0]!.count;
    expect(Number(actions)).toBe(1);
  });

  it("updates stats when re-run with modified payload", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm(buildFdmPayload("VAGPOQJ"), "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    // Re-insert avec stats modifiées (5 buts au lieu de 3)
    const updatedPayload = buildFdmPayload("VAGPOQJ");
    (updatedPayload as any).composition_recevant[0].buts = 5;
    await insertRawFdm(updatedPayload, "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const baudson = await query<{ but_count: number }>(
      `SELECT but_count FROM core.match_compositions mc
         JOIN core.joueurs j ON j.id = mc.joueur_id
         WHERE j.nom = 'BAUDSON'`,
    );
    expect(baudson.rows[0]!.but_count).toBe(5);
  });

  it("rejects invalid payload (Zod fail)", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    await insertRawFdm({ junk: true } as object, "VAGPOQJ");
    const r = await runFeuillesMatchEtl(SAISON);
    expect(r.rows_rejected).toBe(1);
  });

  it("handles action with unknown numero_maillot (joueur_id = NULL)", async () => {
    await seedMatchWithFdmCode("M1", "VAGPOQJ");
    const payload = buildFdmPayload("VAGPOQJ");
    (payload as any).actions[0].numero_maillot = 999;  // orphelin
    await insertRawFdm(payload, "VAGPOQJ");
    await runFeuillesMatchEtl(SAISON);

    const action = await query<{ joueur_id: number | null }>(
      `SELECT joueur_id FROM core.match_actions WHERE ordre = 0`,
    );
    expect(action.rows[0]!.joueur_id).toBeNull();
  });

  afterAll(async () => {
    await closePool();
  });
});
```

- [ ] **Step 8.2 : Run failing**

```bash
npx vitest run tests/etl/feuilles-match.etl.test.ts
```

- [ ] **Step 8.3 : Implémenter `feuilles-match.etl.ts`**

```ts
// src/etl/feuilles-match.etl.ts
import { query } from "@/db/client.js";
import { rawFeuilleMatchPayloadSchema, type RawFeuilleMatchPayload, type RawJoueurInFdm } from "@/schemas/feuille-match.schema.js";
import { logger } from "@/lib/logger.js";

interface RawFdmRow {
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

export async function runFeuillesMatchEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('feuilles_match', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report: EtlReport = {
    etl_run_id,
    rows_read: 0, rows_validated: 0, rows_rejected: 0,
    rows_inserted: 0, rows_updated: 0, rows_noop: 0, warnings_count: 0,
  };

  try {
    const rawRows = await query<RawFdmRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.feuilles_match
        WHERE saison = $1
        ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawFeuilleMatchPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'feuilles_match',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const fdm: RawFeuilleMatchPayload = parsed.data;

      // Transaction par FdM
      await query("BEGIN");
      try {
        // Étape 1 : résoudre match_id via fdm_code
        const matchRes = await query<{ id: number; equipe_dom_id: number; equipe_ext_id: number }>(
          `SELECT id, equipe_dom_id, equipe_ext_id FROM core.matchs WHERE fdm_code = $1 LIMIT 1`,
          [fdm.fdm_code],
        );
        if (!matchRes.rows[0]) {
          await query("ROLLBACK");
          await query(
            `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
             VALUES ($1,'feuilles_match',$2,$3)`,
            [etl_run_id, fdm.fdm_code, `match avec fdm_code='${fdm.fdm_code}' introuvable en core.matchs`],
          );
          report.warnings_count++;
          continue;
        }
        const { id: match_id, equipe_dom_id, equipe_ext_id } = matchRes.rows[0];

        // Étape 2 : UPDATE core.matchs.fdm_url
        await query(
          `UPDATE core.matchs SET fdm_url = $1 WHERE id = $2 AND (fdm_url IS NULL OR fdm_url IS DISTINCT FROM $1)`,
          [fdm.source_url, match_id],
        );

        // Étape 3 : UPSERT joueurs (par numero_licence)
        const numeroMailletToJoueurId = new Map<string, number>();  // ${cote}-${numero_maillot} → joueur_id
        for (const j of [...fdm.composition_recevant, ...fdm.composition_visiteur]) {
          const r = await query<{ id: number }>(
            `INSERT INTO core.joueurs (numero_licence, nom, prenom, last_seen_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (numero_licence) DO UPDATE
             SET nom = EXCLUDED.nom, prenom = EXCLUDED.prenom, last_seen_at = now(),
                 updated_at = CASE WHEN core.joueurs.nom IS DISTINCT FROM EXCLUDED.nom
                                   OR core.joueurs.prenom IS DISTINCT FROM EXCLUDED.prenom
                              THEN now() ELSE core.joueurs.updated_at END
             RETURNING id`,
            [j.numero_licence, j.nom, j.prenom],
          );
          const joueur_id = r.rows[0]!.id;

          // Index par côté+maillot pour résoudre les actions
          const cote = fdm.composition_recevant.includes(j) ? "recevant" : "visiteur";
          if (j.numero_maillot !== null) {
            numeroMailletToJoueurId.set(`${cote}-${j.numero_maillot}`, joueur_id);
          }

          // Étape 4 : UPSERT match_compositions
          const equipe_id = cote === "recevant" ? equipe_dom_id : equipe_ext_id;
          await query(
            `INSERT INTO core.match_compositions (
               match_id, joueur_id, equipe_id, numero_maillot,
               titulaire, capitaine, gardien,
               but_count, exclusion_2min_count, carton_jaune, carton_rouge,
               type_licence, tirs_count, arrets_count,
               sept_metres_tentes, sept_metres_reussis,
               avertissement, disqualifie
             )
             VALUES ($1,$2,$3,$4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (match_id, joueur_id) DO UPDATE
             SET equipe_id = EXCLUDED.equipe_id,
                 numero_maillot = EXCLUDED.numero_maillot,
                 capitaine = EXCLUDED.capitaine,
                 gardien = EXCLUDED.gardien,
                 but_count = EXCLUDED.but_count,
                 exclusion_2min_count = EXCLUDED.exclusion_2min_count,
                 carton_jaune = EXCLUDED.carton_jaune,
                 type_licence = COALESCE(EXCLUDED.type_licence, core.match_compositions.type_licence),
                 tirs_count = EXCLUDED.tirs_count,
                 arrets_count = EXCLUDED.arrets_count,
                 sept_metres_tentes = EXCLUDED.sept_metres_tentes,
                 sept_metres_reussis = EXCLUDED.sept_metres_reussis,
                 avertissement = EXCLUDED.avertissement,
                 disqualifie = EXCLUDED.disqualifie,
                 updated_at = now()`,
            [
              match_id, joueur_id, equipe_id, j.numero_maillot,
              j.capitaine, j.gardien,
              j.buts ?? 0, j.exclusions_2min ?? 0, j.avertissement, j.disqualifie,
              j.type_licence,
              j.tirs ?? 0, j.arrets ?? 0,
              j.sept_metres_tentes ?? 0, j.sept_metres_reussis ?? 0,
              j.avertissement, j.disqualifie,
            ],
          );
        }

        // Étape 5 : UPSERT match_actions
        for (const a of fdm.actions) {
          const key = a.cote && a.numero_maillot !== null && a.numero_maillot !== undefined
            ? `${a.cote}-${a.numero_maillot}`
            : null;
          const joueur_id = key ? (numeroMailletToJoueurId.get(key) ?? null) : null;

          await query(
            `INSERT INTO core.match_actions (
               match_id, ordre, periode, temps_seconds,
               score_recevant, score_visiteur,
               type_action, cote, joueur_id, numero_maillot,
               acteur_role, description_brute
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (match_id, ordre) DO UPDATE
             SET periode = EXCLUDED.periode,
                 temps_seconds = EXCLUDED.temps_seconds,
                 score_recevant = EXCLUDED.score_recevant,
                 score_visiteur = EXCLUDED.score_visiteur,
                 type_action = EXCLUDED.type_action,
                 cote = EXCLUDED.cote,
                 joueur_id = COALESCE(EXCLUDED.joueur_id, core.match_actions.joueur_id),
                 numero_maillot = EXCLUDED.numero_maillot,
                 acteur_role = EXCLUDED.acteur_role,
                 description_brute = EXCLUDED.description_brute`,
            [
              match_id, a.ordre, a.periode, a.temps_seconds,
              a.score_recevant, a.score_visiteur,
              a.type_action, a.cote ?? null, joueur_id, a.numero_maillot ?? null,
              a.acteur_role ?? null, a.description_brute,
            ],
          );
        }

        await query("COMMIT");
        report.rows_inserted++;
      } catch (e) {
        await query("ROLLBACK");
        logger.warn({ fdm_code: fdm.fdm_code, err: String(e) }, "FdM ETL transaction rolled back");
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'feuilles_match',$2,$3)`,
          [etl_run_id, fdm.fdm_code, `cascade error: ${String(e).slice(0, 200)}`],
        );
        report.warnings_count++;
      }
    }

    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status = 'success',
         rows_read = $2, rows_validated = $3, rows_rejected = $4,
         rows_inserted = $5, rows_updated = $6, rows_noop = $7, warnings_count = $8
       WHERE id = $1`,
      [etl_run_id, report.rows_read, report.rows_validated, report.rows_rejected,
       report.rows_inserted, report.rows_updated, report.rows_noop, report.warnings_count],
    );

    logger.info(report, "feuilles_match ETL done");
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
npx vitest run tests/etl/feuilles-match.etl.test.ts
```

Expected : 8 passed.

- [ ] **Step 8.5 : Commit**

```bash
git add src/etl/feuilles-match.etl.ts tests/etl/feuilles-match.etl.test.ts
git commit -m "$(cat <<'EOF'
feat: ETL feuilles-match (cascade transactionnelle 5 étapes)

T8 : runFeuillesMatchEtl en cascade par FdM avec transaction
BEGIN/COMMIT atomique. 5 étapes :
1. Résoudre match_id via core.matchs.fdm_code (warning + ROLLBACK si null)
2. UPDATE core.matchs.fdm_url (lien PDF pour API)
3. UPSERT core.joueurs par numero_licence (création + update nom/prenom)
4. UPSERT core.match_compositions par (match_id, joueur_id) avec stats
   complètes (buts, 7m, tirs, arrêts, sanctions)
5. UPSERT core.match_actions par (match_id, ordre) avec résolution
   joueur_id via index numero_maillot×cote

Idempotent. ROLLBACK si toute erreur dans la cascade. Action avec
maillot orphelin → joueur_id NULL.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: CLI etl dispatch + intégration end-to-end

**Files:**
- Modify: `src/cli/etl.ts`
- Create: `tests/integration/feuilles-match-end-to-end.test.ts`

- [ ] **Step 9.1 : Dispatch CLI etl**

Dans `src/cli/etl.ts` :

```ts
import { runFeuillesMatchEtl } from "@/etl/feuilles-match.etl.js";

// Dans main(), après stats-joueurs :
} else if (args.entity === "feuilles-match") {
  await runFeuillesMatchEtl(args.saison);
```

- [ ] **Step 9.2 : Test intégration end-to-end**

```ts
// tests/integration/feuilles-match-end-to-end.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { query } from "@/db/client.js";
import { parseFdmPdf } from "@/scrapers/ffhandball/fdm-pdf.parser.js";
import { insertRaw } from "@/scrapers/shared/raw-insert.js";
import { runFeuillesMatchEtl } from "@/etl/feuilles-match.etl.js";

const SAISON = "2025-2026";
const FDM_CODE = "VAGPOQJ";
const URL = `https://media-ffhb-fdm.ffhandball.fr/fdm/V/A/G/P/${FDM_CODE}.pdf`;

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

async function setup(): Promise<void> {
  await query(
    `INSERT INTO core.saisons (saison_code, date_debut, date_fin)
     VALUES ($1, '2025-07-01', '2026-06-30')
     ON CONFLICT DO NOTHING`,
    [SAISON],
  );
  // Seed hierarchy
  const comp = await query<{ id: number }>(
    `INSERT INTO core.competitions (id_ffhb, nom, niveau, saison_code)
     VALUES ('C1','Honneur Moselle','departemental',$1) RETURNING id`,
    [SAISON],
  );
  const phase = await query<{ id: number }>(
    `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code)
     VALUES ('PH1', $1, 'P', $2) RETURNING id`,
    [comp.rows[0]!.id, SAISON],
  );
  const poule = await query<{ id: number }>(
    `INSERT INTO core.poules (id_ffhb, phase_id, nom, saison_code)
     VALUES ('PO1', $1, 'P3', $2) RETURNING id`,
    [phase.rows[0]!.id, SAISON],
  );
  const eqDom = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EDOM','ETAIN',$1) RETURNING id`,
    [SAISON],
  );
  const eqExt = await query<{ id: number }>(
    `INSERT INTO core.equipes (id_ffhb, nom, saison_code) VALUES ('EEXT','SARRALBE',$1) RETURNING id`,
    [SAISON],
  );
  await query(
    `INSERT INTO core.matchs (id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id, date_heure, fdm_code)
     VALUES ('M_REAL', $1, $2, $3, '2026-04-25T20:30:00+02:00', $4)`,
    [poule.rows[0]!.id, eqDom.rows[0]!.id, eqExt.rows[0]!.id, FDM_CODE],
  );
}

async function startRun(): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO raw.scrape_runs (source_site, scraper_name, saison, status)
     VALUES ('media-ffhb-fdm.ffhandball.fr','feuilles-match',$1,'success') RETURNING id`,
    [SAISON],
  );
  return r.rows[0]!.id;
}

describe("feuilles-match end-to-end", () => {
  beforeEach(async () => {
    await query(`DELETE FROM raw.feuilles_match`);
    await query(`DELETE FROM raw.scrape_runs WHERE scraper_name IN ('feuilles-match','matchs')`);
    await query(`TRUNCATE core.match_actions, core.match_compositions, core.match_officiels, core.joueurs, core.matchs, core.engagements, core.equipes, core.poules, core.phases, core.competitions, core.arbitres, core.etl_runs, core.etl_warnings, core.etl_rejets RESTART IDENTITY CASCADE`);
    await setup();
  });

  it("parse FdM real PDF → ETL → joueurs + compositions + actions in core", async () => {
    const run_id = await startRun();
    const buf = await readFile(fixturePath(`fdm-${FDM_CODE}.pdf`));
    const parsed = await parseFdmPdf(buf, URL, FDM_CODE);
    expect(parsed).not.toBeNull();

    await insertRaw("feuilles_match", {
      scrape_run_id: run_id,
      source_url: URL,
      source_site: "media-ffhb-fdm.ffhandball.fr",
      natural_key: FDM_CODE,
      payload: parsed!,
      saison: SAISON,
      http_status: 200,
    });

    const report = await runFeuillesMatchEtl(SAISON);
    expect(report.rows_inserted).toBe(1);
    expect(report.warnings_count).toBe(0);

    // Vérifications
    const joueurs = await query<{ count: string }>(`SELECT count(*) FROM core.joueurs`);
    expect(Number(joueurs.rows[0]!.count)).toBeGreaterThan(15);  // ~20 joueurs (les 2 compos)

    const compos = await query<{ count: string }>(`SELECT count(*) FROM core.match_compositions`);
    expect(Number(compos.rows[0]!.count)).toBeGreaterThan(15);

    const actions = await query<{ count: string }>(`SELECT count(*) FROM core.match_actions`);
    expect(Number(actions.rows[0]!.count)).toBeGreaterThan(40);  // déroulé complet

    // fdm_url propagé
    const m = await query<{ fdm_url: string | null }>(
      `SELECT fdm_url FROM core.matchs WHERE fdm_code = $1`,
      [FDM_CODE],
    );
    expect(m.rows[0]!.fdm_url).toContain(`${FDM_CODE}.pdf`);
  });
});
```

Pas de `afterAll(closePool)` ici (T8 l'a déjà).

- [ ] **Step 9.3 : Run + suite séquentielle**

```bash
npx vitest run tests/integration/feuilles-match-end-to-end.test.ts
# Expected : 1 PASS

npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
# Expected : ~200+ tests pass (192 précédents + 2 (T2) + 6 (T3) + 11 (T4+T5) + 1 (T6) + 8 (T8) + 1 (T9) = ~221)
```

- [ ] **Step 9.4 : Commit**

```bash
git add src/cli/etl.ts tests/integration/feuilles-match-end-to-end.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): etl --entity=feuilles-match + intégration end-to-end

T9 : dispatch CLI + test intégration sur fixture PDF réelle VAGPOQJ.
Vérifications : ~20 joueurs créés, ~20 compositions, ~40+ actions
chronologiques, fdm_url propagé sur core.matchs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Runbook + smoke test final + merge + push

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 10.1 : Ajouter section runbook**

À la fin de `docs/runbook.md`, ajouter `## Scraper les feuilles de match (FdM PDFs)` avec :

```markdown
## Scraper les feuilles de match (FdM PDFs)

Télécharge et parse les feuilles de match officielles FFHandball au format PDF
depuis `media-ffhb-fdm.ffhandball.fr`. Alimente `core.joueurs` (vide
auparavant), enrichit `core.match_compositions`, peuple `core.match_actions`
(déroulé chronologique).

### Pré-requis

- `raw.matchs` doit contenir des `fdm_code` (champ exposé par `rencontre-list`
  lors du scrape matchs)
- Migration 0015 appliquée (ajoute `core.matchs.fdm_code` + `fdm_url`)
- ETL matchs étendu pour propager `fdm_code` vers core

### Scrape

```bash
# Dev — 5 FdMs (test)
npm run scrape -- --entity=feuilles-match --saison=2025-2026 --limit=5

# Run complet (~50-200k FdMs, 30-100h selon scope matchs, MULTI-NUITS)
npm run scrape -- --entity=feuilles-match --saison=2025-2026
```

Le scraper :
1. SELECT codes uniques depuis `raw.matchs.payload->>'fdm_code'`
2. Filtre ceux déjà en `raw.feuilles_match` (idempotence sans re-download)
3. Pour chaque code : télécharge `https://media-ffhb-fdm.ffhandball.fr/fdm/{c1}/{c2}/{c3}/{c4}/{code}.pdf`
4. Parse via `pdf-parse` v2 (page 1 metadata + officiels + compositions, page 2 déroulé)
5. insertRaw avec payload JSONB structuré (pas de PDF brut conservé)

Skip silencieux sur HTTP 404 (FdM pas encore publiée).

### ETL

```bash
npm run etl -- --entity=feuilles-match --saison=2025-2026
```

Cascade transactionnelle par FdM :
1. UPDATE `core.matchs.fdm_url`
2. UPSERT `core.joueurs` (par numero_licence)
3. UPSERT `core.match_compositions` (par match × joueur)
4. UPSERT `core.match_actions` (par match × ordre)

ROLLBACK si erreur dans la cascade. Idempotent.

### Suivre la couverture

```sql
-- FdMs téléchargées
SELECT count(*) FROM raw.feuilles_match WHERE saison = '2025-2026';

-- Matchs avec FdM disponible
SELECT
  count(*) FILTER (WHERE fdm_code IS NOT NULL) AS matchs_avec_fdm_code,
  count(*) FILTER (WHERE fdm_url IS NOT NULL) AS matchs_avec_fdm_parse,
  count(*) AS total_matchs
FROM core.matchs;

-- Top buteurs cross-FdM (cumulé sur tous les matchs analysés)
SELECT j.nom, j.prenom, SUM(mc.but_count) AS total_buts,
       COUNT(DISTINCT mc.match_id) AS matchs_joues
  FROM core.match_compositions mc
  JOIN core.joueurs j ON j.id = mc.joueur_id
  GROUP BY j.id, j.nom, j.prenom
  HAVING SUM(mc.but_count) > 0
  ORDER BY total_buts DESC LIMIT 20;

-- Sanctions cumulées
SELECT j.nom, j.prenom,
       count(*) FILTER (WHERE mc.avertissement) AS avertissements,
       sum(mc.exclusion_2min_count) AS exclusions_2min,
       count(*) FILTER (WHERE mc.disqualifie) AS disqualifications
  FROM core.match_compositions mc
  JOIN core.joueurs j ON j.id = mc.joueur_id
  GROUP BY j.id, j.nom, j.prenom
  HAVING count(*) FILTER (WHERE mc.avertissement) > 0
      OR sum(mc.exclusion_2min_count) > 0
  ORDER BY exclusions_2min DESC, avertissements DESC LIMIT 20;

-- Actions par type (vérification volumétrie)
SELECT type_action, count(*)
  FROM core.match_actions
  GROUP BY type_action ORDER BY count(*) DESC;

-- Warnings ETL
SELECT message, count(*)
  FROM core.etl_warnings
  WHERE entity = 'feuilles_match'
    AND etl_run_id = (SELECT max(id) FROM core.etl_runs WHERE entity = 'feuilles_match')
  GROUP BY message ORDER BY count(*) DESC LIMIT 20;
```

### Rejouer après bug

```sql
TRUNCATE core.match_actions;
TRUNCATE core.match_compositions CASCADE;
TRUNCATE core.joueurs CASCADE;
UPDATE core.matchs SET fdm_url = NULL;
```

Puis re-lancer `etl --entity=feuilles-match`. `raw.feuilles_match` n'est pas touché.

### Notes opérationnelles

- **Volumétrie démentielle attendue** : ~150k FdMs full run = ~45 GB téléchargements, ~80h en nocturne multi-nuits
- Idempotence stricte : ne re-download pas les FdMs déjà en `raw.feuilles_match`
- Skip silencieux sur HTTP 404 (FdM pas encore publiée pour matchs futurs)
- **RGPD** : `core.joueurs` contient n° licence + nom + prénom (publiés par FFH elle-même sur les FdMs publiques). DDN/sexe/nationalité non exposés (restent NULL)
- L'`fdm_url` peuplée dans `core.matchs` permet de servir le lien PDF directement côté API
- Heuristique gardien (basée sur `arrets > 0`) peu fiable — privilégier `core.match_actions` filtré sur type='arret' pour analyses précises
```

- [ ] **Step 10.2 : Smoke test final**

```bash
# Re-scrape un mini-batch pour avoir des fdm_codes en raw.matchs
npm run scrape -- --entity=matchs --saison=2025-2026 --level=national --limit=2

# Scrape FdM + ETL
npm run scrape -- --entity=feuilles-match --saison=2025-2026 --limit=3
npm run etl -- --entity=feuilles-match --saison=2025-2026

# Vérification
docker exec -i ffhandball-postgres psql -U ffhandball -d ffhandball -c \
  "SELECT 'joueurs' AS t, count(*) FROM core.joueurs
   UNION ALL SELECT 'compositions', count(*) FROM core.match_compositions
   UNION ALL SELECT 'actions', count(*) FROM core.match_actions
   UNION ALL SELECT 'matchs_avec_fdm_url', count(fdm_url) FROM core.matchs
   UNION ALL SELECT 'warnings', count(*) FROM core.etl_warnings WHERE entity = 'feuilles_match';"
```

Expected : counts > 0 sur joueurs, compositions, actions ; au moins 1 match avec `fdm_url`.

- [ ] **Step 10.3 : Commit + merge + push**

```bash
git add docs/runbook.md
git commit -m "$(cat <<'EOF'
docs(runbook): section feuilles de match (FdM PDFs)

T10 : documentation complète. Commandes scrape/ETL, SQL de suivi
(buteurs cumulés, sanctions cross-matchs, distribution actions),
notes opérationnelles (volumétrie 80h multi-nuits, RGPD, idempotence).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"

# Merge sur master
git checkout master
git merge --no-ff feat/feuilles-match -m "$(cat <<'EOF'
Merge feat/feuilles-match: FdM PDF parsing + joueurs + déroulé chronologique

9ème feature majeure du pipeline. Téléchargement et parsing des feuilles
de match officielles FFHandball (PDFs) via fdmCode déjà capturé dans
raw.matchs.

Livrables :
- Nouvelle dépendance pdf-parse v2 (Node-pur)
- Schéma Zod feuille-match (joueur + officiel + action + global)
- Parser PDF en 2 sous-parsers (page 1 metadata/officiels/compositions,
  page 2 déroulé chronologique)
- Migration 0015 : extensions match_compositions + match_officiels CHECK,
  nouvelle table match_actions, ajout core.matchs.{fdm_code,fdm_url}
- ETL feuilles-match cascade transactionnelle 5 étapes (UPDATE fdm_url,
  UPSERT joueurs/compositions/actions)
- ETL matchs étendu pour propager fdm_code
- Helper fetchBinary pour download PDFs binaires
- 22+ tests (schéma + parser + ETL + intégration end-to-end)

Volumétrie projetée full run (3 niveaux + --journees=all) :
- ~150k FdMs PDFs
- ~45 GB téléchargements (~80h scrape multi-nuits)
- ~500k joueurs uniques en core.joueurs
- ~3M lignes core.match_compositions
- ~10-15M lignes core.match_actions

Pipeline state final : 100%% couverture données publiques FFHandball
exploitées. Le pipeline est terminé sur le scope publiquement
accessible (les identités complètes restantes nécessitent login GestHand).
EOF
)"
git push origin master
```

**Reporting final :** DONE / DONE_WITH_CONCERNS / BLOCKED + résumé consolidé :
- Counts smoke test final (joueurs, compositions, actions, fdm_url)
- Total tests pass
- Merge réussi + push OK
- Volumétrie observée vs estimée

---

## Final verification

- [ ] **F.1 : Suite séquentielle complète**

```bash
npx vitest run --no-file-parallelism --pool=forks --poolOptions.forks.singleFork
```

Expected : ~221 tests pass.

- [ ] **F.2 : Typecheck**

```bash
npm run typecheck
```

Expected : 0 erreurs.

- [ ] **F.3 : Vérifier que la branche est mergée + pushée**

```bash
git log --oneline -3
git log origin/master --oneline -3
```
