// src/cli/monitor.ts — surveille l'état du pipeline et alerte par mail en cas de problème.
// Usage : pnpm monitor [--saison=2025-2026] [--max-age-hours=36] [--stale-score-days=10] [--digest]
//
// Détecte : runs scrape/ETL en échec (failed/partial), absence d'activité récente (fraîcheur),
// et matchs joués depuis longtemps toujours sans score. Envoie un mail si problème (ou --digest).
// Sort en 0 quand le monitoring s'est exécuté (même si des problèmes ont été trouvés et notifiés) ;
// sort en 1 seulement si le monitoring lui-même échoue (ex. base injoignable).
import { parseArgs } from "node:util";
import { closePool, query } from "@/db/client.js";
import { env } from "@/config/env.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { sendMail } from "@/lib/mailer.js";
import { renderEmail, emailTable, emailCallout, emailList, emailCodeBlock, escapeHtml } from "@/lib/email-template.js";

interface RunRow {
  kind: "scrape" | "etl";
  name: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  error_message: string | null;
  pages_scraped: number | null;
  pages_total: number | null;
}

interface NoScoreMatch {
  id_ffhb_match: string;
  date_heure: Date;
  statut: string;
  competition: string;
  poule: string;
  dom: string;
  ext: string;
  /** Page de la poule (journée du match) sur ffhandball.fr, null si competition sans detail_url. */
  url: string | null;
  fdm_code: string | null;
  cause: string;
  fdm_http: number | null;
  fdm_attempts: number | null;
  fdm_last_attempt: Date | null;
}

/** URL du PDF de FdM (même schéma que le scrape feuilles-match). */
function fdmPdfUrl(code: string): string | null {
  return code.length < 4 ? null : `https://fdm.fdme.ffhandball.fr/${code[0]}/${code[1]}/${code[2]}/${code[3]}/${code}.pdf`;
}

interface NoScoreDetails {
  /** Matchs sans score À SURVEILLER (hors bruit). */
  total: number;
  /** Parmi eux, ceux passés le seuil depuis moins de 24 h (nouveaux depuis hier). */
  nouveaux: number;
  /** Matchs sans score mais sans FdM attendue : ne déclenchent pas l'alerte. */
  bruit: Array<{ kind: string; n: number }>;
  parStatut: Array<{ statut: string; n: number }>;
  parCause: Array<{ cause: string; n: number }>;
  parCompetition: Array<{ competition: string; n: number }>;
  matchs: NoScoreMatch[];
  sql: string;
}

const DETAIL_LIMIT = 30;

const NO_SCORE_WHERE = `po.saison_code = $1
        AND m.date_heure < now() - ($2::int * interval '1 day')
        AND m.score_dom IS NULL
        AND m.statut <> 'forfait'`;

async function noScoreDetails(saison: string, days: number): Promise<NoScoreDetails> {
  const params = [saison, days, env.SCRAPE_FDM_MAX_AGE_DAYS];
  const from = `FROM core.matchs m
       JOIN core.poules po ON po.id = m.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
       JOIN core.equipes ed ON ed.id = m.equipe_dom_id
       JOIN core.equipes ee ON ee.id = m.equipe_ext_id
       LEFT JOIN raw.feuilles_match_fetch_state fs ON fs.fdm_code = m.fdm_code AND fs.saison = po.saison_code
      WHERE ${NO_SCORE_WHERE}`;
  // Bruit probable (n'alerte pas) : tournois de détection (pas de FdM) et FdM en 404 depuis plus
  // de SCRAPE_FDM_MAX_AGE_DAYS (forfait / match non joué : la feuille ne viendra plus).
  const noise = `(c.nom ILIKE '%TOURNOI%'
         OR (fs.status = 'not_found' AND m.date_heure < now() - ($3::int * interval '1 day')))`;
  const real = `${from} AND NOT ${noise}`;
  const noisy = `${from} AND ${noise}`;
  // Cause probable : le score est dérivé de la FdM quand ffhandball ne le publie pas (cf. feuilles-match.etl).
  const cause = `CASE
         WHEN m.fdm_code IS NULL THEN 'Pas de code FdM sur le listing ffhandball'
         WHEN EXISTS (SELECT 1 FROM raw.feuilles_match fm WHERE fm.natural_key = m.fdm_code AND fm.saison = po.saison_code)
           THEN 'FdM récupérée mais score non appliqué (ETL feuilles-match à relancer ?)'
         WHEN fs.status = 'not_found' THEN 'FdM introuvable (404)'
         WHEN fs.status = 'parse_failed' THEN 'PDF de FdM illisible (parse_failed)'
         WHEN m.date_heure < now() - interval '30 days'
           THEN 'FdM jamais tentée : match hors fenêtre des crons quotidien/hebdo (>30 j), attend le rattrapage mensuel'
         ELSE 'FdM pas encore tentée'
       END`;
  const causes = await query<{ cause: string; n: string }>(
    `SELECT ${cause} AS cause, count(*)::bigint AS n ${real} GROUP BY 1 ORDER BY n DESC`, params);
  const statut = await query<{ statut: string; n: string }>(
    `SELECT m.statut, count(*)::bigint AS n ${real} GROUP BY m.statut ORDER BY n DESC`, params);
  const comp = await query<{ competition: string; n: string }>(
    `SELECT c.nom AS competition, count(*)::bigint AS n ${real} GROUP BY c.nom ORDER BY n DESC LIMIT 10`, params);
  const matchs = await query<NoScoreMatch>(
    `SELECT m.id_ffhb_match, m.date_heure, m.statut, c.nom AS competition, po.nom AS poule,
            ed.nom AS dom, ee.nom AS ext, m.fdm_code, ${cause} AS cause,
            fs.http_status AS fdm_http, fs.attempts AS fdm_attempts, fs.last_attempt_at AS fdm_last_attempt,
            c.detail_url || 'poule-' || po.id_ffhb || '/'
              || CASE WHEN m.journee IS NOT NULL THEN '?numero_journee=' || m.journee ELSE '' END AS url
       ${real} ORDER BY m.date_heure ASC LIMIT ${DETAIL_LIMIT}`, params);
  const nouveaux = await query<{ n: string }>(
    `SELECT count(*)::bigint AS n ${real} AND m.date_heure >= now() - (($2::int + 1) * interval '1 day')`, params);
  const bruit = await query<{ kind: string; n: string }>(
    `SELECT CASE WHEN c.nom ILIKE '%TOURNOI%' THEN 'Tournois (pas de FdM attendue)'
                 ELSE 'FdM introuvable (404) depuis plus de ' || $3::int || ' j (forfait / non joué probable)' END AS kind,
            count(*)::bigint AS n ${noisy} GROUP BY 1 ORDER BY n DESC`, params);
  const parStatut = statut.rows.map((r) => ({ statut: r.statut, n: Number(r.n) }));
  const sql = [
    "SELECT m.id_ffhb_match, m.date_heure, m.statut, po.nom AS poule",
    "  FROM core.matchs m JOIN core.poules po ON po.id = m.poule_id",
    ` WHERE po.saison_code = '${saison}'`,
    `   AND m.date_heure < now() - interval '${days} days'`,
    "   AND m.score_dom IS NULL",
    "   AND m.statut <> 'forfait'",
    " ORDER BY m.date_heure;",
  ].join("\n");
  return {
    total: parStatut.reduce((a, r) => a + r.n, 0),
    nouveaux: Number(nouveaux.rows[0]!.n),
    bruit: bruit.rows.map((r) => ({ kind: r.kind, n: Number(r.n) })),
    parStatut,
    parCause: causes.rows.map((r) => ({ cause: r.cause, n: Number(r.n) })),
    parCompetition: comp.rows.map((r) => ({ competition: r.competition, n: Number(r.n) })),
    matchs: matchs.rows,
    sql,
  };
}

const H = (t: string): string =>
  `<div style="height:18px;"></div><div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;font-weight:700;color:#0f172a;">${t}</div><div style="height:8px;"></div>`;

const fmtDate = (d: Date): string => d.toISOString().slice(0, 16).replace("T", " ");

const NOTE_STYLE = "font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;color:#64748b;margin-top:6px;";

/** Matchs sans score mais sans FdM attendue : listés pour info, jamais en alerte. */
function bruitHtml(d: NoScoreDetails): string {
  if (d.bruit.length === 0) return "";
  return (
    H("Sans score mais sans alerte (bruit probable)") +
    emailTable(["Catégorie", "Nb"], d.bruit.map((r) => [r.kind, String(r.n)]), ["l", "r"])
  );
}

function noScoreHtml(d: NoScoreDetails, days: number): string {
  const shown = d.matchs.length;
  return [
    H(`Matchs sans score à surveiller (&gt; ${days} j) — détail`),
    `<div style="${NOTE_STYLE}">${d.nouveaux} nouveau(x) depuis hier (passés le seuil de ${days} j dans les dernières 24 h).</div><div style="height:8px;"></div>`,
    emailTable(["Statut", "Nb"], d.parStatut.map((r) => [r.statut, String(r.n)]), ["l", "r"]),
    H("Cause probable (état de la FdM)"),
    emailTable(["Cause", "Nb"], d.parCause.map((r) => [r.cause, String(r.n)]), ["l", "r"]),
    `<div style="${NOTE_STYLE}">Un match perdu par forfait n'a pas de FdM : le lien PDF renverra alors une erreur (404). Passé ${env.SCRAPE_FDM_MAX_AGE_DAYS} j, ces matchs sont classés en bruit.</div>`,
    H("Par compétition (top 10)"),
    emailTable(["Compétition", "Nb"], d.parCompetition.map((r) => [r.competition, String(r.n)]), ["l", "r"]),
    H(`Les ${shown} plus anciens${d.total > shown ? ` (sur ${d.total})` : ""}`),
    scroll(emailTable(
      ["Date (UTC)", "Poule", "Match", "FdM / cause", "Liens"],
      d.matchs.map((m) => {
        const link = (href: string | null, label: string): string =>
          href ? `<a href="${escapeHtml(href)}" style="color:#2563eb;">${escapeHtml(label)}</a>` : escapeHtml(label);
        const pdf = m.fdm_code ? fdmPdfUrl(m.fdm_code) : null;
        const tentative = m.fdm_attempts
          ? ` (HTTP ${m.fdm_http}, ${m.fdm_attempts} essai(s), dernier ${m.fdm_last_attempt ? fmtDate(m.fdm_last_attempt) : "?"})`
          : "";
        return [
          fmtDate(m.date_heure),
          `${m.competition} — ${m.poule}`,
          `${m.dom} vs ${m.ext}`,
          `${m.cause}${tentative}${m.fdm_code ? ` — code ${m.fdm_code}` : ""}`,
          { html: [link(m.url, "Poule"), pdf ? link(pdf, "PDF FdM") : ""].filter(Boolean).join(" · ") },
        ];
      }),
    )),
    H("Requête pour vérifier (pnpm db:psql)"),
    emailCodeBlock(d.sql),
  ].join("");
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

const STATUS_ICON: Record<string, string> = {
  success: "✅ ok",
  running: "⏳ en cours",
  partial: "⚠️ partiel",
  failed: "❌ échec",
};

function fmtDuration(from: Date, to: Date | null): string {
  const s = Math.max(0, Math.round(((to ?? new Date()).getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;
}

/** Tableau des dernières exécutions (une ligne par scraper / entité ETL). */
function runsHtml(runs: RunRow[]): string {
  const sorted = [...runs].sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
  return (
    H("Dernières exécutions") +
    scroll(
      emailTable(
        ["Étape", "Statut", "Début (UTC)", "Durée"],
        sorted.map((r) => [
          `${r.kind === "scrape" ? "scrape" : "etl"} · ${r.name}`,
          (STATUS_ICON[r.status] ?? r.status) +
            (r.status === "running" && r.pages_total ? ` (${r.pages_scraped ?? 0}/${r.pages_total})` : ""),
          fmtDate(r.started_at),
          fmtDuration(r.started_at, r.finished_at),
        ]),
        ["l", "l", "l", "r"],
      ),
    )
  );
}

/** Évite que les tableaux larges cassent la mise en page sur mobile. */
const scroll = (html: string): string => `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">${html}</div>`;

interface Activity {
  matchsMisAJour: number;
  resultats: number;
  fdmCaptees: number;
  dbSize: string;
}

async function activity24h(saison: string): Promise<Activity> {
  const m = await query<{ maj: string; res: string }>(
    `SELECT count(*)::bigint AS maj,
            count(*) FILTER (WHERE m.score_dom IS NOT NULL)::bigint AS res
       FROM core.matchs m JOIN core.poules po ON po.id = m.poule_id
      WHERE po.saison_code = $1 AND m.updated_at > now() - interval '24 hours'`,
    [saison],
  );
  const f = await query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM raw.feuilles_match WHERE saison = $1 AND scraped_at > now() - interval '24 hours'`,
    [saison],
  );
  const d = await query<{ size: string }>(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
  return {
    matchsMisAJour: Number(m.rows[0]!.maj),
    resultats: Number(m.rows[0]!.res),
    fdmCaptees: Number(f.rows[0]!.n),
    dbSize: d.rows[0]!.size,
  };
}

function activityHtml(a: Activity): string {
  return (
    H("Activité des dernières 24 h") +
    emailTable(
      ["Indicateur", "Valeur"],
      [
        ["Matchs créés ou mis à jour", String(a.matchsMisAJour)],
        ["… dont avec un résultat", String(a.resultats)],
        ["Feuilles de match capturées", String(a.fdmCaptees)],
        ["Taille de la base", a.dbSize],
      ],
      ["l", "r"],
    )
  );
}

function buildHtml(
  saison: string,
  problems: string[],
  rejets24h: number,
  runs: RunRow[],
  extraHtml: string,
  act: Activity,
): string {
  const failed = runs.filter((r) => r.status === "failed" || r.status === "partial");
  const body = [
    problems.length
      ? emailCallout(`<strong>${problems.length} problème(s) détecté(s)</strong>${emailList(problems)}`, "warning")
      : emailCallout("Aucun problème détecté — tous les runs récents sont au vert.", "success"),
    `<div style="height:14px;"></div>`,
    `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;color:#64748b;">Rejets ETL sur les dernières 24 h : <strong style="color:#334155;">${rejets24h}</strong></div>`,
    failed.length
      ? `<div style="height:16px;"></div><div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;font-weight:700;color:#0f172a;">Runs en échec / partiels</div><div style="height:8px;"></div>` +
        emailTable(
          ["Entité", "Statut", "Début (UTC)", "Erreur"],
          failed.map((r) => [r.name, r.status, fmtDate(r.started_at), (r.error_message ?? "").slice(0, 500)]),
        )
      : "",
    activityHtml(act),
    extraHtml,
    runsHtml(runs),
    rejets24h > 0
      ? H("Rejets ETL (24 h)") +
        emailCodeBlock(
          "SELECT * FROM core.etl_rejets\nWHERE created_at > now() - interval '24 hours'\nORDER BY created_at DESC;",
        )
      : "",
  ].join("");
  return renderEmail({
    status: problems.length ? "warning" : "success",
    title: `Récap quotidien — saison ${saison}`,
    preheader: problems.length ? `${problems.length} problème(s) détecté(s)` : "Tout est au vert — récap de la nuit",
    bodyHtml: body,
    footerNote: "Récap quotidien ffhandball",
  });
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
  // Saison courante attendue (bascule le 1er juillet, comme deploy/cron/lib-saison.sh).
  const now = new Date();
  const startYear = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const expectedSaison = `${startYear}-${startYear + 1}`;

  // Dernier run par scraper et par entité ETL.
  const scrape = await query<RunRow>(
    `SELECT DISTINCT ON (scraper_name) 'scrape' AS kind, scraper_name AS name, status, started_at, finished_at, error_message,
            pages_scraped, pages_total
       FROM raw.scrape_runs WHERE saison = $1 ORDER BY scraper_name, started_at DESC`,
    [saison],
  );
  const etl = await query<RunRow>(
    `SELECT DISTINCT ON (entity) 'etl' AS kind, entity AS name, status, started_at, finished_at, error_message,
            NULL::int AS pages_scraped, NULL::int AS pages_total
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

  // 1bis. Mauvaise saison : les crons (ou la dernière activité) ne tournent pas sur la saison courante.
  if (!values.saison && saison !== expectedSaison) {
    problems.push(
      `La dernière activité concerne la saison ${saison}, pas la saison courante ${expectedSaison} : les crons ciblent peut-être la mauvaise saison`,
    );
  }

  // 1ter. Scrape « réussi » mais vide : signe d'une cible erronée ou d'un site qui a changé.
  for (const r of scrape.rows) {
    if ((r.name === "matchs" || r.name === "competitions") && r.status === "success" && r.pages_scraped === 0) {
      problems.push(`scrape ${r.name} : succès mais 0 page traitée (${fmtDate(r.started_at)})`);
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
  const noScore = await noScoreDetails(saison, staleScoreDays);
  let extraHtml = "";
  if (noScore.total > 0) {
    const statuts = noScore.parStatut.map((r) => `${r.n} ${r.statut}`).join(", ");
    const nouveaux = noScore.nouveaux > 0 ? `, dont ${noScore.nouveaux} nouveau(x) depuis hier` : "";
    problems.push(`${noScore.total} match(s) joué(s) il y a >${staleScoreDays} j sans score (${statuts}${nouveaux})`);
    extraHtml = noScoreHtml(noScore, staleScoreDays);
  }
  extraHtml += bruitHtml(noScore);

  // Info : rattrapage FdM en cours (les causes « jamais tentée » se résorbent alors d'elles-mêmes).
  const fdmRun = scrape.rows.find((r) => r.name === "feuilles-match" && r.status === "running");
  if (fdmRun) {
    const prog = fdmRun.pages_total ? ` (${fdmRun.pages_scraped ?? 0}/${fdmRun.pages_total} PDF)` : "";
    extraHtml =
      `<div style="height:14px;"></div>` +
      emailCallout(`<strong>Rattrapage des FdM en cours</strong>${prog} — démarré le ${fmtDate(fdmRun.started_at)}. Les matchs « jamais tentés » seront traités à sa fin ; le site de FdM peut limiter le débit (HTTP 429).`, "info") +
      extraHtml;
  }

  // Info : rejets ETL sur 24 h.
  const rejets = await query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM core.etl_rejets WHERE created_at > now() - interval '24 hours'`,
  );
  const rejets24h = Number(rejets.rows[0]!.n);

  const act = await activity24h(saison);
  const ok = problems.length === 0;
  process.stdout.write(`${ok ? "✅" : "⚠️"} Monitoring ${saison} — ${ok ? "OK" : problems.length + " problème(s)"}\n`);
  for (const p of problems) process.stdout.write(`  - ${p}\n`);
  for (const m of noScore.matchs.slice(0, 10)) {
    process.stdout.write(`    · ${fmtDate(m.date_heure)} ${m.competition} — ${m.poule} : ${m.dom} vs ${m.ext} [${m.cause}] ${m.url ?? m.id_ffhb_match}${m.fdm_code ? ` fdm=${m.fdm_code}` : ""}\n`);
  }
  process.stdout.write(`  24 h : ${act.matchsMisAJour} match(s) mis à jour (${act.resultats} avec résultat), ${act.fdmCaptees} FdM captée(s), base ${act.dbSize}\n`);
  for (const b of noScore.bruit) process.stdout.write(`  (i) bruit sans alerte : ${b.n} — ${b.kind}`+String.fromCharCode(10));
  if (rejets24h > 0) process.stdout.write(`  (i) ${rejets24h} rejet(s) ETL sur 24 h\n`);

  if (!ok || values.digest) {
    // Objet explicite : le problème lui-même quand il est unique, sinon le nombre de problèmes.
    const headline = problems.length === 1 ? problems[0]!.split(" (")[0]! : `${problems.length} problèmes détectés`;
    const subject = `[ffhandball] ${ok ? "✅ Récap quotidien — tout est OK" : "⚠️ " + headline} — ${saison}`;
    await sendMail(
      subject,
      buildHtml(saison, problems, rejets24h, runs, extraHtml, act),
    );
  }
}

main()
  .catch((err) => {
    process.stderr.write(`Erreur monitoring : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
