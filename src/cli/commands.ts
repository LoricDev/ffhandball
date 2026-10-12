// src/cli/commands.ts — liste toutes les commandes du projet, groupées et commentées.
// Usage : pnpm commands [--no-color]
// (Pas de dépendance base/env : utilisable n'importe où, même sans .env.)
import { parseArgs } from "node:util";
import { initColor, col } from "@/lib/cli-color.js";

interface Cmd {
  name: string;
  desc: string;
}
interface Group {
  title: string;
  cmds: Cmd[];
}

const GROUPS: Group[] = [
  {
    title: "Pipeline & données",
    cmds: [
      { name: "pipeline", desc: "Orchestre tout le scrape + ETL d'une saison. --only=<entités> --from=<étape> --level --continue-on-error --dry-run" },
      { name: "scrape", desc: "Scrape une entité (--entity=clubs|competitions|matchs|classements|stats-joueurs|feuilles-match… --saison). --journees=all|recent|courante --level --weekend/--live/--days --limit" },
      { name: "etl", desc: "Transforme le raw capturé en tables core normalisées (--entity --saison)" },
    ],
  },
  {
    title: "Exploitation & monitoring",
    cmds: [
      { name: "status", desc: "État du pipeline : volumétrie, couverture raw→core, stockage (--saison --json --no-color)" },
      { name: "diag", desc: "Diagnostic préflight : DB, migrations, env, source, disque. Code de sortie pour cron/CI (--strict)" },
      { name: "monitor", desc: "Surveille échecs/fraîcheur/matchs sans score, alerte par mail (--digest --max-age-hours --stale-score-days)" },
      { name: "maintenance", desc: "Purge api_logs anciens + VACUUM ANALYZE (--api-logs-days=90 --dry-run)" },
      { name: "prune-raw", desc: "Rétention du schéma raw append-only (--keep=N | --older-than-days=N, --apply)" },
      { name: "poules:actives", desc: "Combien de poules jouent sur une fenêtre + estimation du temps de scrape" },
      { name: "notify", desc: "Envoie un mail (sujet + corps) ; primitive pour scripts bash/cron" },
      { name: "mail:test", desc: "Vérifie la config SMTP et envoie un mail de test" },
    ],
  },
  {
    title: "Base de données",
    cmds: [
      { name: "migrate", desc: "Runner de migrations SQL : up | status | baseline (via DATABASE_URL)" },
      { name: "db:up", desc: "Démarre Postgres (docker compose up -d)" },
      { name: "db:down", desc: "Arrête Postgres" },
      { name: "db:reset", desc: "Réinitialise Postgres (down -v + up) — ⚠ efface les données" },
      { name: "db:migrate", desc: "(legacy) applique les .sql via docker psql — préfère `pnpm migrate`" },
      { name: "db:seed", desc: "Charge les seeds (saisons, ligues/départements)" },
      { name: "db:psql", desc: "Ouvre un shell psql sur la base" },
    ],
  },
  {
    title: "API",
    cmds: [
      { name: "api", desc: "Serveur HTTP (Hono) + Swagger UI" },
      { name: "api:dev", desc: "Idem en mode watch (rechargement à chaud)" },
      { name: "apikey", desc: "Gestion des clés API : create | list | renew | revoke" },
    ],
  },
  {
    title: "Développement",
    cmds: [
      { name: "typecheck", desc: "Vérifie les types (tsc --noEmit)" },
      { name: "test", desc: "Lance les tests (vitest run)" },
      { name: "test:watch", desc: "Tests en mode watch" },
      { name: "commands", desc: "Affiche cette liste" },
    ],
  },
];

function main(): void {
  const { values } = parseArgs({ options: { "no-color": { type: "boolean" } } });
  initColor(values["no-color"] === true ? false : undefined);

  process.stdout.write("\n" + col.bold("ffhandball — commandes disponibles") + "\n");
  for (const g of GROUPS) {
    const w = Math.max(...g.cmds.map((c) => c.name.length));
    process.stdout.write("\n" + col.cyan(col.bold(g.title)) + "\n");
    for (const cmd of g.cmds) {
      process.stdout.write(`  ${col.green("pnpm " + cmd.name.padEnd(w))}  ${col.dim(cmd.desc)}\n`);
    }
  }
  process.stdout.write(
    "\n" +
      col.dim("Astuce : la plupart acceptent --saison, --dry-run et --no-color. ") +
      col.dim("Détail d'une commande : voir l'en-tête de `src/cli/<nom>.ts`.") +
      "\n\n",
  );
}

main();
