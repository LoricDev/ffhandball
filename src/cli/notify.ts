// src/cli/notify.ts — envoie un mail (sujet + corps) via le mailer configuré.
// Primitive utilisable depuis les scripts bash (ex. cron healthcheck) :
//   pnpm notify "[ffhandball] API down" "le /ready ne répond plus"
// No-op silencieux si MAIL_* n'est pas configuré (cf. sendMail).
import { sendMail } from "@/lib/mailer.js";

async function main(): Promise<void> {
  const subject = process.argv[2];
  const body = process.argv[3] ?? "";
  if (!subject) {
    process.stderr.write('Usage : pnpm notify "<sujet>" "<corps>"\n');
    process.exitCode = 1;
    return;
  }
  const html = `<pre style="font-family:monospace;font-size:13px">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
  await sendMail(subject, html);
}

main().catch((err) => {
  process.stderr.write(`Erreur notify : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
