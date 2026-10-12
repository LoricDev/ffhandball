// src/cli/mail-test.ts — vérifie la config SMTP et envoie un mail de test.
// Usage : pnpm mail:test
import nodemailer from "nodemailer";
import { env } from "@/config/env.js";

async function main(): Promise<void> {
  const missing = (["MAIL_HOST", "MAIL_PORT", "MAIL_USER", "MAIL_PASSWORD", "MAIL_FROM", "MAIL_TO"] as const)
    .filter((k) => !env[k]);
  if (missing.length > 0) {
    process.stderr.write(`✗ Variables manquantes dans .env : ${missing.join(", ")}\n`);
    process.exit(1);
  }

  process.stdout.write(
    [
      "Config SMTP utilisée :",
      `  host      : ${env.MAIL_HOST}`,
      `  port      : ${env.MAIL_PORT} (secure=${env.MAIL_PORT === 465})`,
      `  user      : ${env.MAIL_USER}`,
      `  pass      : ${"*".repeat(String(env.MAIL_PASSWORD).length)} (${String(env.MAIL_PASSWORD).length} caractères)`,
      `  from      : ${env.MAIL_FROM}`,
      `  to        : ${env.MAIL_TO}`,
      "",
    ].join("\n"),
  );

  const transport = nodemailer.createTransport({
    host:   env.MAIL_HOST,
    port:   env.MAIL_PORT,
    secure: env.MAIL_PORT === 465,
    auth:   { user: env.MAIL_USER, pass: env.MAIL_PASSWORD },
  });

  process.stdout.write("→ Vérification de la connexion + authentification...\n");
  await transport.verify();
  process.stdout.write("✓ Authentification SMTP OK.\n\n");

  process.stdout.write("→ Envoi du mail de test...\n");
  const info = await transport.sendMail({
    from:    env.MAIL_FROM,
    to:      env.MAIL_TO,
    subject: "[ffhandball] Mail de test ✅",
    html:    "<h2>✅ Test réussi</h2><p>La configuration Mailjet fonctionne.</p>",
  });
  process.stdout.write(`✓ Mail envoyé (messageId=${info.messageId}).\n`);
  process.stdout.write(`  Vérifie la boîte de réception de ${env.MAIL_TO}\n`);
}

main().catch((err) => {
  process.stderr.write(`\n✗ Échec : ${err instanceof Error ? err.message : String(err)}\n`);
  if (String(err).includes("535")) {
    process.stderr.write(
      [
        "",
        "→ Erreur 535 = identifiants rejetés par Mailjet. Vérifie :",
        "  • MAIL_USER doit être ta API Key (publique), PAS ton email de compte",
        "  • MAIL_PASSWORD doit être ta Secret Key (privée)",
        "  • Source : app.mailjet.com → Account Settings → REST API → API Key Management",
        "  • Pas d'espaces ni de guillemets autour des valeurs dans .env",
        "",
      ].join("\n"),
    );
  }
  process.exit(1);
});
