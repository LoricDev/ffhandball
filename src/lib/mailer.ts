// src/lib/mailer.ts — envoi de mails via SMTP (nodemailer).
// Si les variables MAIL_* ne sont pas configurées, les envois sont silencieusement ignorés.
import { hostname } from "node:os";
import nodemailer from "nodemailer";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { renderEmail, emailTable, emailCallout, emailCodeBlock, escapeHtml } from "@/lib/email-template.js";

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

/** Somme des durées « 12.3s » des étapes, formatée (« 4 min 05 s »). */
function totalDuration(steps: { duration: string }[]): string {
  const secs = Math.round(steps.reduce((a, s) => a + (parseFloat(s.duration) || 0), 0));
  if (secs < 60) return `${secs} s`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, "0")} s`;
  return `${Math.floor(secs / 3600)} h ${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")} min`;
}

function stepsTable(steps: { label: string; duration: string }[]): string {
  return emailTable(
    ["Étape", "Statut", "Durée"],
    steps.map((s) => [s.label, "✓ OK", s.duration]),
    ["l", "l", "r"],
  );
}

export async function sendPipelineSuccess(saison: string, steps: { label: string; duration: string }[]): Promise<void> {
  const html = renderEmail({
    status: "success",
    title: `Pipeline terminé — saison ${saison}`,
    preheader: `${steps.length} étapes terminées avec succès`,
    intro: `Toutes les étapes du pipeline se sont terminées avec succès en ${totalDuration(steps)}.`,
    bodyHtml: steps.length > 0 ? stepsTable(steps) : undefined,
    footerNote: `Pipeline ffhandball · saison ${saison} · ${hostname()}`,
  });
  await sendMail(`[ffhandball] ✅ Pipeline ${saison} terminé en ${totalDuration(steps)}`, html);
}

export async function sendPipelineFailure(saison: string, failedStep: string, error: string, completed: { label: string; duration: string }[]): Promise<void> {
  // Libellé complet de la 1re étape en échec (« etl clubs ») : « --from » le résout sans ambiguïté,
  // contrairement au dernier mot seul (« clubs » reprendrait à « scrape clubs »).
  const relance = `pnpm pipeline --saison=${saison} --from="${failedStep.split(", ")[0]}"`;
  const body = [
    emailCallout(`<strong>Étape échouée :</strong> <code style="font-family:monospace;background:rgba(0,0,0,.06);padding:1px 6px;border-radius:4px;">${escapeHtml(failedStep)}</code>`, "failure"),
    `<div style="height:14px;line-height:14px;">&nbsp;</div>`,
    emailCodeBlock(error),
    completed.length > 0
      ? `<div style="margin-top:18px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;font-weight:700;color:#0f172a;">Étapes complétées avant l'échec</div><div style="height:8px;"></div>${stepsTable(completed)}`
      : "",
    `<div style="height:14px;"></div>`,
    emailCallout(
      `Relance possible : <code style="font-family:monospace;">${escapeHtml(relance)}</code><br>` +
        `Sur le serveur <strong>${escapeHtml(hostname())}</strong>, dans <code style="font-family:monospace;">/opt/ffhandball</code>. ` +
        `Voir aussi <code style="font-family:monospace;">pnpm status</code> et les logs dans <code style="font-family:monospace;">/var/log/ffhandball/</code>.`,
      "info",
    ),
  ].join("");

  const html = renderEmail({
    status: "failure",
    title: `Pipeline échoué — saison ${saison}`,
    preheader: `Échec à l'étape : ${failedStep}`,
    bodyHtml: body,
    footerNote: `Pipeline ffhandball · saison ${saison} · ${hostname()}`,
  });
  await sendMail(`[ffhandball] ❌ Pipeline ${saison} échoué — ${failedStep}`, html);
}
