// src/cli/monitor.ts — surveille l'état du pipeline et alerte par mail en cas de problème.
// Usage : pnpm monitor [--saison=2025-2026] [--max-age-hours=36] [--stale-score-days=10] [--digest]
//
// Détecte : runs scrape/ETL en échec (failed/partial), absence d'activité récente (fraîcheur),
// et matchs joués depuis longtemps toujours sans score. Envoie un mail si problème (ou --digest).
// Sort en 0 quand le monitoring s'est exécuté (même si des problèmes ont été trouvés et notifiés) ;
// sort en 1 seulement si le monitoring lui-même échoue (ex. base injoignable).
import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { sendMail } from "@/lib/mailer.js";

interface RunRow {
  name: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  error_message: string | null;
}

async function latestSaison(): Promise<string | null> {
  const r = await query<{ saison: string }>(
    `SELECT saison FROM (
       SELECT saison, max(started_at) m FROM raw.scrape_runs GROUP BY saison
       UNION ALL
       SELECT saison, max(started_at) m FROM core.etl_runs WHERE saison IS NOT NULL GROUP BY saison
     ) u GROUP BY saison ORDER BY max(m) DESC LIMIT 1`,
  );
  return r.rows[0]?.saison ?? null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildHtml(saison: string, problems: string[], rejets24h: number, runs: RunRow[]): string {
  const probList = problems.length
    ? `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
    : `<p style="color:#16a34a">Aucun problème détecté.</p>`;
  const failed = runs.filter((r) => r.status === "failed" || r.status === "partial");
  const failedTable = failed.length
    ? `<h3>Runs en échec / partiels</h3>
       <table border="1" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:13px">
         <tr style="background:#f1f5f9"><th style="padding:4px 12px">entité</th><th style="padding:4px 12px">statut</th><th style="padding:4px 12px">erreur</th></tr>
         ${failed
           .map(
             (r) =>
               `<tr><td style="padding:4px 12px">${esc(r.name)}</td><td style="padding:4px 12px;color:#dc2626">${r.status}</td><td style="padding:4px 12px">${esc((r.error_message ?? "").slice(0, 160))}</td></tr>`,
           )
           .join("")}
       </table>`
    : "";
  return `
    <h2>${problems.length ? "⚠️" : "✅"} Monitoring ffhandball — saison ${saison}</h2>
    ${probList}
    <p style="color:#64748b">Rejets ETL sur 24 h : ${rejets24h}</p>
    ${failedTable}
  `;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      saison: { type: "string" },
      "max-age-hours": { type: "string" },
      "stale-score-days": { type: "string" },
      digest: { type: "boolean" },
    },
  });
  const maxAgeHours = Number(values["max-age-hours"] ?? 36);
  const staleScoreDays = Number(values["stale-score-days"] ?? 10);
  const saison = values.saison ? canonicalizeSaison(values.saison) : await latestSaison();
  if (!saison) throw new Error("Aucune saison en base.");

  // Dernier run par scraper et par entité ETL.
  const scrape = await query<RunRow>(
    `SELECT DISTINCT ON (scraper_name) scraper_name AS name, status, started_at, finished_at, error_message
       FROM raw.scrape_runs WHERE saison = $1 ORDER BY scraper_name, started_at DESC`,
    [saison],
  );
  const etl = await query<RunRow>(
    `SELECT DISTINCT ON (entity) entity AS name, status, started_at, finished_at, error_message
       FROM core.etl_runs WHERE saison = $1 ORDER BY entity, started_at DESC`,
    [saison],
  );
  const runs = [...scrape.rows, ...etl.rows];

  const problems: string[] = [];

  // 1. Runs en échec ou partiels (dernière exécution).
  for (const r of runs) {
    if (r.status === "failed" || r.status === "partial") {
      problems.push(`${r.name} : ${r.status}${r.error_message ? " — " + r.error_message.slice(0, 120) : ""}`);
    }
  }

  // 2. Fraîcheur : aucune activité depuis trop longtemps.
  let last: Date | null = null;
  for (const r of runs) {
    const d = r.finished_at ?? r.started_at;
    if (!last || d.getTime() > last.getTime()) last = d;
  }
  const ageH = last ? (Date.now() - last.getTime()) / 3_600_000 : Infinity;
  if (ageH > maxAgeHours) {
    problems.push(`Aucune activité depuis ${last ? Math.round(ageH) + " h" : "jamais"} (seuil ${maxAgeHours} h)`);
  }

  // 3. Qualité : matchs joués il y a longtemps, toujours sans score.
  const noScore = await query<{ n: string }>(
    `SELECT count(*)::bigint AS n
       FROM core.matchs m JOIN core.poules po ON po.id = m.poule_id
      WHERE po.saison_code = $1
        AND m.date_heure < now() - ($2::int * interval '1 day')
        AND m.score_dom IS NULL`,
    [saison, staleScoreDays],
  );
  const noScoreN = Number(noScore.rows[0]!.n);
  if (noScoreN > 0) {
    problems.push(`${noScoreN} match(s) joué(s) il y a >${staleScoreDays} j sans score (FdM non publiée ?)`);
  }

  // Info : rejets ETL sur 24 h.
  const rejets = await query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM core.etl_rejets WHERE created_at > now() - interval '24 hours'`,
  );
  const rejets24h = Number(rejets.rows[0]!.n);

  const ok = problems.length === 0;
  process.stdout.write(`${ok ? "✅" : "⚠️"} Monitoring ${saison} — ${ok ? "OK" : problems.length + " problème(s)"}\n`);
  for (const p of problems) process.stdout.write(`  - ${p}\n`);
  if (rejets24h > 0) process.stdout.write(`  (i) ${rejets24h} rejet(s) ETL sur 24 h\n`);

  if (!ok || values.digest) {
    await sendMail(
      `[ffhandball] ${ok ? "✅ Monitoring OK" : "⚠️ Alerte"} — ${saison}`,
      buildHtml(saison, problems, rejets24h, runs),
    );
  }
}

main()
  .catch((err) => {
    process.stderr.write(`Erreur monitoring : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
