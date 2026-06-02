import { parseArgs } from "node:util";
import { logger } from "@/lib/logger.js";
import { closePool, query } from "@/db/client.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";
import { runSallesEtl } from "@/etl/salles.etl.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";
import { runEquipesEtl } from "@/etl/equipes.etl.js";
import { runEngagementsEtl } from "@/etl/engagements.etl.js";
import { runMatchsEtl } from "@/etl/matchs.etl.js";
import { runArbitresEtl } from "@/etl/arbitres.etl.js";
import { runMatchOfficielsEtl } from "@/etl/match_officiels.etl.js";
import { runClassementsEtl } from "@/etl/classements.etl.js";
import { runStatsJoueursEtl } from "@/etl/stats-joueurs.etl.js";
import { runFeuillesMatchEtl } from "@/etl/feuilles-match.etl.js";

interface CliArgs {
  entity: string;
  saison: string;
  since?: string;
  incremental: boolean;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      entity: { type: "string" },
      saison: { type: "string" },
      // matchs uniquement : ne retraiter que le delta du dernier scrape.
      since: { type: "string" },           // timestamp ISO explicite
      incremental: { type: "boolean" },    // = depuis le dernier ETL matchs réussi
    },
  });
  if (!values.entity) throw new Error("--entity required");
  if (!values.saison) throw new Error("--saison required");
  return {
    entity: values.entity,
    saison: canonicalizeSaison(values.saison),
    since: values.since,
    incremental: values.incremental === true,
  };
}

/** Timestamp de fin du dernier ETL matchs réussi pour la saison (pour --incremental). */
async function lastSuccessfulMatchsEtl(saison: string): Promise<Date | null> {
  const r = await query<{ finished_at: Date | null }>(
    `SELECT finished_at FROM core.etl_runs
      WHERE entity = 'matchs' AND saison = $1 AND status = 'success' AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`,
    [saison],
  );
  return r.rows[0]?.finished_at ?? null;
}

/** Résout la borne `since` du mode incrémental matchs (--since explicite ou --incremental auto). */
async function resolveMatchsSince(args: CliArgs): Promise<Date | undefined> {
  if (args.since) {
    const d = new Date(args.since);
    if (Number.isNaN(d.getTime())) throw new Error(`--since invalide : ${args.since}`);
    return d;
  }
  if (args.incremental) {
    const last = await lastSuccessfulMatchsEtl(args.saison);
    if (!last) {
      logger.warn("--incremental : aucun ETL matchs réussi antérieur, run complet");
      return undefined;
    }
    return last;
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  let report;
  if (args.entity === "clubs") {
    report = await runClubsEtl(args.saison);
  } else if (args.entity === "salles") {
    report = await runSallesEtl(args.saison);
  } else if (args.entity === "competitions") {
    report = await runCompetitionsEtl(args.saison);
  } else if (args.entity === "phases") {
    report = await runPhasesEtl(args.saison);
  } else if (args.entity === "poules") {
    report = await runPoulesEtl(args.saison);
  } else if (args.entity === "equipes") {
    report = await runEquipesEtl(args.saison);
  } else if (args.entity === "engagements") {
    report = await runEngagementsEtl(args.saison);
  } else if (args.entity === "matchs") {
    report = await runMatchsEtl(args.saison, { since: await resolveMatchsSince(args) });
  } else if (args.entity === "arbitres") {
    report = await runArbitresEtl(args.saison);
  } else if (args.entity === "match_officiels") {
    report = await runMatchOfficielsEtl(args.saison);
  } else if (args.entity === "classements") {
    await runClassementsEtl(args.saison);
  } else if (args.entity === "stats-joueurs") {
    await runStatsJoueursEtl(args.saison);
  } else if (args.entity === "feuilles-match") {
    await runFeuillesMatchEtl(args.saison);
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
