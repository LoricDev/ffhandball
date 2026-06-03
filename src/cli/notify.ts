// src/cli/notify.ts — envoie un mail (sujet + corps) via le mailer, avec un rendu soigné.
// Primitive utilisable depuis les scripts bash (ex. cron healthcheck) :
//   pnpm notify "[ffhandball] ❌ API down" "le /ready ne répond plus"
// No-op silencieux si MAIL_* n'est pas configuré (cf. sendMail).
import { sendMail } from "@/lib/mailer.js";
import { renderEmail, type EmailStatus } from "@/lib/email-template.js";

// Déduit le statut visuel (couleur) à partir du sujet — pratique depuis bash.
function statusFor(subject: string): EmailStatus {
  const s = subject.toLowerCase();
  if (subject.includes("✅") || s.includes("rétabli") || s.includes("retabli")) return "success";
  if (subject.includes("❌") || s.includes("échou") || s.includes("echou") || s.includes("injoignable") || s.includes("down")) return "failure";
  if (subject.includes("⚠") || s.includes("alerte")) return "warning";
  return "info";
}

async function main(): Promise<void> {
  const subject = process.argv[2];
  const body = process.argv[3] ?? "";
  if (!subject) {
    process.stderr.write('Usage : pnpm notify "<sujet>" "<corps>"\n');
    process.exitCode = 1;
    return;
  }
  // Titre nettoyé : on retire le préfixe [ffhandball] et les emojis de tête (le gabarit
  // affiche déjà la marque + une pastille de statut).
  const title =
    subject
      .replace(/^\[ffhandball\]\s*/i, "")
      .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}️\s]+/u, "")
      .trim() || subject;

  const html = renderEmail({
    status: statusFor(subject),
    title,
    preheader: body.slice(0, 120),
    intro: body || undefined,
    footerNote: "Notification ffhandball",
  });
  await sendMail(subject, html);
}

main().catch((err) => {
  process.stderr.write(`Erreur notify : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
