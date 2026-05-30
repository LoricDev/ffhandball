// src/lib/mailer.ts — envoi de mails via SMTP (nodemailer).
// Si les variables MAIL_* ne sont pas configurées, les envois sont silencieusement ignorés.
import nodemailer from "nodemailer";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";

function isConfigured(): boolean {
  return !!(env.MAIL_HOST && env.MAIL_USER && env.MAIL_PASSWORD && env.MAIL_FROM && env.MAIL_TO);
}

function createTransport() {
  return nodemailer.createTransport({
    host:   env.MAIL_HOST,
    port:   env.MAIL_PORT,
    secure: env.MAIL_PORT === 465,
    auth: {
      user: env.MAIL_USER,
      pass: env.MAIL_PASSWORD,
    },
  });
}

export async function sendMail(subject: string, html: string): Promise<void> {
  if (!isConfigured()) {
    logger.debug("mail non configuré, envoi ignoré");
    return;
  }
  try {
    const transport = createTransport();
    await transport.sendMail({
      from:    env.MAIL_FROM,
      to:      env.MAIL_TO,
      subject,
      html,
    });
    logger.info({ to: env.MAIL_TO, subject }, "mail envoyé");
  } catch (err) {
    logger.warn({ err }, "échec envoi mail");
  }
}

export async function sendPipelineSuccess(saison: string, steps: { label: string; duration: string }[]): Promise<void> {
  const rows = steps.map((s) =>
    `<tr><td style="padding:4px 12px">${s.label}</td><td style="padding:4px 12px;color:#16a34a">✓</td><td style="padding:4px 12px">${s.duration}</td></tr>`,
  ).join("");

  const html = `
    <h2>✅ Pipeline ffhandball terminé — saison ${saison}</h2>
    <p>Toutes les étapes se sont terminées avec succès.</p>
    <table border="1" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:13px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:4px 12px">Étape</th>
          <th style="padding:4px 12px">Statut</th>
          <th style="padding:4px 12px">Durée</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  await sendMail(`[ffhandball] ✅ Pipeline ${saison} terminé`, html);
}

export async function sendPipelineFailure(saison: string, failedStep: string, error: string, completed: { label: string; duration: string }[]): Promise<void> {
  const rows = completed.map((s) =>
    `<tr><td style="padding:4px 12px">${s.label}</td><td style="padding:4px 12px;color:#16a34a">✓</td><td style="padding:4px 12px">${s.duration}</td></tr>`,
  ).join("");

  const html = `
    <h2>❌ Pipeline ffhandball échoué — saison ${saison}</h2>
    <p><strong>Étape échouée :</strong> <code>${failedStep}</code></p>
    <pre style="background:#fef2f2;padding:12px;border-radius:4px;color:#dc2626">${error}</pre>
    ${completed.length > 0 ? `
    <h3>Étapes complétées avant l'échec :</h3>
    <table border="1" cellspacing="0" style="border-collapse:collapse;font-family:monospace;font-size:13px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:4px 12px">Étape</th>
          <th style="padding:4px 12px">Statut</th>
          <th style="padding:4px 12px">Durée</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#64748b">Relance possible avec : <code>npm run pipeline -- --saison=${saison} --from=${failedStep.split(" ").pop()}</code></p>
    ` : ""}
  `;
  await sendMail(`[ffhandball] ❌ Pipeline ${saison} échoué — ${failedStep}`, html);
}
