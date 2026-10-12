// src/cli/poules-actives.ts — combien de poules jouent sur une fenêtre (ex. un week-end),
// et estimation du temps de scrape correspondant (dimensionner un passage de rafraîchissement).
//
// Usage : pnpm poules:actives [--saison=2025-2026] [--weekend] [--from=YYYY-MM-DD --to=YYYY-MM-DD]
import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";
import { env } from "@/config/env.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { resolveDateWindow, weekendWindow } from "@/scrapers/shared/date-window.js";

interface NiveauRow {
  niveau: string;
  poules: number;
  matchs: number;
}

// Coût observé par requête : attente du rate-limit + ~130 ms de fetch/parse/insert.
const OVERHEAD_S = 0.13;

function fmtDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}`;
}

async function latestSaison(): Promise<string | null> {
  const r = await query<{ saison_code: string }>(
    `SELECT max(saison_code) AS saison_code FROM core.poules`,
  );
  return r.rows[0]?.saison_code ?? null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      saison: { type: "string" },
      live: { type: "boolean" },
      weekend: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
    },
  });

  const saison = values.saison
    ? canonicalizeSaison(values.saison)
    : (await latestSaison()) ?? undefined;
  if (!saison) throw new Error("Aucune saison en base. Précisez --saison.");

  // Par défaut : le week-end courant.
  const window =
    resolveDateWindow(
      { from: values.from, to: values.to, weekend: values.weekend === true, live: values.live === true },
      new Date(),
    ) ?? weekendWindow(new Date());

  const res = await query<{ niveau: string; poules: string; matchs: string }>(
    `SELECT c.niveau,
            count(DISTINCT po.id)::bigint AS poules,
            count(*)::bigint             AS matchs
       FROM core.poules po
       JOIN core.phases ph       ON ph.id = po.phase_id
       JOIN core.competitions c  ON c.id = ph.competition_id
       JOIN core.matchs m        ON m.poule_id = po.id
                                AND m.date_heure >= $2 AND m.date_heure < $3
      WHERE po.saison_code = $1
      GROUP BY c.niveau
      ORDER BY c.niveau`,
    [saison, window.from, window.to],
  );

  const rows: NiveauRow[] = res.rows.map((r) => ({
    niveau: r.niveau,
    poules: Number(r.poules),
    matchs: Number(r.matchs),
  }));

  const perReq = env.SCRAPE_RATE_LIMIT_MS / 1000 + OVERHEAD_S;
  const totalPoules = rows.reduce((a, r) => a + r.poules, 0);
  const totalMatchs = rows.reduce((a, r) => a + r.matchs, 0);

  const W = 72;
  const out = (s = ""): void => {
    process.stdout.write(s + "\n");
  };
  const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const rpad = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);

  out();
  out("═".repeat(W));
  out(` POULES ACTIVES — saison ${saison}`);
  out(`  fenêtre : ${fmtDate(window.from)} → ${fmtDate(window.to)}  (heure locale)`);
  out(`  débit estimé : ${perReq.toFixed(2)} s/poule (rate-limit ${env.SCRAPE_RATE_LIMIT_MS} ms + ~${OVERHEAD_S}s)`);
  out("═".repeat(W));
  out(`  ${pad("niveau", 16)} ${rpad("poules", 8)} ${rpad("matchs", 8)} ${rpad("temps scrape", 14)}`);
  out("  " + "─".repeat(W - 2));

  const line = (label: string, poules: number, matchs: number): void => {
    const secs = poules * perReq;
    out(
      `  ${pad(label, 16)} ${rpad(String(poules), 8)} ${rpad(String(matchs), 8)} ${rpad(fmtDuration(secs), 14)}`,
    );
  };

  for (const r of rows) line(r.niveau, r.poules, r.matchs);
  out("  " + "─".repeat(W - 2));
  line("TOTAL", totalPoules, totalMatchs);

  out();
  if (totalPoules === 0) {
    out("  Aucun match dans la fenêtre — rien à rafraîchir (ou ETL matchs pas encore passé).");
  } else {
    out(
      `  → Scraper ces poules (--days/--weekend) prend ~${fmtDuration(totalPoules * perReq)} au débit actuel.` +
        ` Cibler par --level pour réduire.`,
    );
  }
  out();
}

main()
  .catch((err) => {
    process.stderr.write(`Erreur : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
