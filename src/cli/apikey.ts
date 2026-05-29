// src/cli/apikey.ts — gestion des clés API en ligne de commande.
// Usage : npm run apikey -- <create|list|renew|revoke> [options]
import { parseArgs } from "node:util";
import { closePool } from "@/db/client.js";
import { createApiKey, listApiKeys, renewApiKey, revokeApiKey } from "@/api/lib/repositories/api-keys.repo.js";

function usage(): void {
  process.stdout.write(
    [
      "Usage : npm run apikey -- <commande> [options]",
      "",
      "  create   --label=<email/nom> [--months=1] [--rate=120] [--no-expiry]",
      "  list",
      "  renew    --prefix=ffhb_xxxxxxxx [--months=1]",
      "  revoke   --prefix=ffhb_xxxxxxxx",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: "string" },
      months: { type: "string" },
      rate: { type: "string" },
      prefix: { type: "string" },
      "no-expiry": { type: "boolean" },
    },
  });
  const cmd = positionals[0];

  switch (cmd) {
    case "create": {
      const created = await createApiKey({
        label: values.label,
        months: values.months ? Number(values.months) : undefined,
        rate_limit_per_min: values.rate ? Number(values.rate) : undefined,
        noExpiry: values["no-expiry"] === true,
      });
      process.stdout.write(
        [
          "✅ Clé API créée. ⚠️  Le token n'est affiché QU'UNE FOIS — copie-le maintenant :",
          "",
          `   TOKEN       : ${created.token}`,
          `   key_prefix  : ${created.key_prefix}`,
          `   label       : ${created.label ?? "(aucun)"}`,
          `   valid_until : ${created.valid_until ?? "(jamais)"}`,
          `   rate/min    : ${created.rate_limit_per_min}`,
          "",
        ].join("\n"),
      );
      break;
    }
    case "list": {
      const keys = await listApiKeys();
      if (keys.length === 0) {
        process.stdout.write("Aucune clé API.\n");
        break;
      }
      for (const k of keys) {
        process.stdout.write(
          `${k.key_prefix}  active=${k.active}  valid_until=${k.valid_until ?? "∞"}  rate=${k.rate_limit_per_min}  last_used=${k.last_used_at ?? "-"}  label=${k.label ?? "-"}\n`,
        );
      }
      break;
    }
    case "renew": {
      if (!values.prefix) throw new Error("--prefix requis");
      const res = await renewApiKey(values.prefix, values.months ? Number(values.months) : 1);
      if (!res) throw new Error(`Clé ${values.prefix} introuvable`);
      process.stdout.write(`✅ ${values.prefix} renouvelée → valid_until=${res.valid_until}\n`);
      break;
    }
    case "revoke": {
      if (!values.prefix) throw new Error("--prefix requis");
      const ok = await revokeApiKey(values.prefix);
      if (!ok) throw new Error(`Clé ${values.prefix} introuvable`);
      process.stdout.write(`✅ ${values.prefix} révoquée (active=false)\n`);
      break;
    }
    default:
      usage();
      process.exitCode = cmd ? 1 : 0;
  }
}

main()
  .catch((err) => {
    process.stderr.write(`Erreur : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
