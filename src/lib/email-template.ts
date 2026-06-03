// src/lib/email-template.ts — gabarit HTML d'e-mail réutilisable et soigné.
// Contraintes e-mail : layout en <table>, CSS *inline*, polices système, largeur 600px,
// fallbacks Outlook (bgcolor), dégradation propre de border-radius/box-shadow.

export type EmailStatus = "success" | "failure" | "warning" | "info";

interface Palette {
  accent: string;
  soft: string;
  text: string;
  label: string;
  icon: string;
}

const PALETTE: Record<EmailStatus, Palette> = {
  success: { accent: "#16a34a", soft: "#dcfce7", text: "#166534", label: "Succès", icon: "✓" },
  failure: { accent: "#dc2626", soft: "#fee2e2", text: "#991b1b", label: "Échec", icon: "✕" },
  warning: { accent: "#d97706", soft: "#fef3c7", text: "#92400e", label: "Alerte", icon: "!" },
  info: { accent: "#2563eb", soft: "#dbeafe", text: "#1e40af", label: "Info", icon: "i" },
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";
const INK = "#0f172a";
const MUTED = "#64748b";
const BORDER = "#e2e8f0";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

interface EmailOptions {
  status: EmailStatus;
  title: string;
  preheader?: string;
  intro?: string;
  bodyHtml?: string;
  footerNote?: string;
  generatedAt?: Date;
}

/** Document HTML complet, prêt à envoyer. `title`/`intro` sont échappés ; `bodyHtml` est brut. */
export function renderEmail(o: EmailOptions): string {
  const p = PALETTE[o.status];
  const generated = fmtDate(o.generatedAt ?? new Date());
  const preheader = o.preheader ? escapeHtml(o.preheader) : "";

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f1f5f9;">${preheader}&zwnj;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f1f5f9" style="background:#f1f5f9;">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(15,23,42,.10);">
      <tr><td bgcolor="${p.accent}" style="height:4px;line-height:4px;font-size:0;background:${p.accent};">&nbsp;</td></tr>
      <tr><td bgcolor="${INK}" style="background:${INK};padding:18px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-family:${FONT};font-size:17px;font-weight:700;color:#ffffff;letter-spacing:.2px;">🤾 ffhandball</td>
          <td align="right"><span style="display:inline-block;background:${p.accent};color:#ffffff;font-family:${FONT};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;padding:5px 12px;border-radius:999px;">${p.label}</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:26px 28px 6px;">
        <h1 style="margin:0;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:700;color:${INK};">
          <span style="display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;border-radius:50%;background:${p.soft};color:${p.text};font-size:14px;font-weight:700;vertical-align:middle;margin-right:8px;">${p.icon}</span>
          ${escapeHtml(o.title)}
        </h1>
      </td></tr>
      ${o.intro ? `<tr><td style="padding:8px 28px 0;font-family:${FONT};font-size:14px;line-height:1.6;color:#475569;">${escapeHtml(o.intro)}</td></tr>` : ""}
      ${o.bodyHtml ? `<tr><td style="padding:18px 28px 6px;">${o.bodyHtml}</td></tr>` : ""}
      <tr><td style="padding:18px 28px 22px;">
        <div style="border-top:1px solid ${BORDER};padding-top:14px;font-family:${FONT};font-size:12px;color:${MUTED};">
          ${o.footerNote ? escapeHtml(o.footerNote) + " · " : ""}généré le ${generated}
        </div>
      </td></tr>
    </table>
    <div style="font-family:${FONT};font-size:11px;color:#94a3b8;padding:14px 0 0;">Pipeline de données handball — message automatique</div>
  </td></tr>
</table>
</body>
</html>`;
}

/** Table stylée. `headers`/`rows` sont échappés. `align` optionnel par colonne ('l'|'r'). */
export function emailTable(headers: string[], rows: string[][], align: Array<"l" | "r"> = []): string {
  const th = headers
    .map(
      (h, i) =>
        `<th align="${align[i] === "r" ? "right" : "left"}" style="padding:9px 14px;font-family:${FONT};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${MUTED};border-bottom:1px solid ${BORDER};">${escapeHtml(h)}</th>`,
    )
    .join("");
  const body = rows
    .map((r, ri) => {
      const bg = ri % 2 === 0 ? "#ffffff" : "#f8fafc";
      const tds = r
        .map(
          (cell, i) =>
            `<td align="${align[i] === "r" ? "right" : "left"}" style="padding:9px 14px;font-family:${FONT};font-size:13px;color:#334155;border-bottom:1px solid ${BORDER};">${escapeHtml(cell)}</td>`,
        )
        .join("");
      return `<tr bgcolor="${bg}" style="background:${bg};">${tds}</tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;width:100%;border:1px solid ${BORDER};border-radius:10px;overflow:hidden;"><tr bgcolor="#f8fafc" style="background:#f8fafc;">${th}</tr>${body}</table>`;
}

/** Encart coloré (bord gauche accentué). `html` est brut (déjà échappé par l'appelant si besoin). */
export function emailCallout(html: string, status: EmailStatus = "info"): string {
  const p = PALETTE[status];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="${p.soft}" style="background:${p.soft};border-left:4px solid ${p.accent};border-radius:8px;padding:12px 16px;font-family:${FONT};font-size:13px;line-height:1.6;color:${p.text};">${html}</td></tr></table>`;
}

/** Liste à puces stylée. Items échappés. */
export function emailList(items: string[]): string {
  return `<ul style="margin:0;padding-left:20px;font-family:${FONT};font-size:13px;line-height:1.7;color:#334155;">${items
    .map((i) => `<li style="margin:2px 0;">${escapeHtml(i)}</li>`)
    .join("")}</ul>`;
}

/** Bloc de code/erreur monospace. `text` est échappé. */
export function emailCodeBlock(text: string): string {
  return `<pre style="margin:0;background:#0f172a;color:#e2e8f0;font-family:${MONO};font-size:12px;line-height:1.5;padding:14px 16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;">${escapeHtml(text)}</pre>`;
}
