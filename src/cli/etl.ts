import { parseArgs } from "node:util";
import { logger } from "@/lib/logger.js";
import { closePool } from "@/db/client.js";
import { canonicalizeSaison } from "@/etl/shared/parse-saison.js";
import { runClubsEtl } from "@/etl/clubs.etl.js";
import { runSallesEtl } from "@/etl/salles.etl.js";
import { runCompetitionsEtl } from "@/etl/competitions.etl.js";
import { runPhasesEtl } from "@/etl/phases.etl.js";
import { runPoulesEtl } from "@/etl/poules.etl.js";
import { runEquipesEtl } from "@/etl/equipes.etl.js";
import { runEngagementsEtl } from "@/etl/engagements.etl.js";

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
