import { describe, it, expect } from "vitest";
import {
  renderEmail,
  emailTable,
  emailCallout,
  emailList,
  emailCodeBlock,
  escapeHtml,
} from "@/lib/email-template.js";

const FIXED = new Date(Date.UTC(2026, 5, 3, 7, 0));

describe("renderEmail", () => {
  it("produit un document complet avec marque, titre et date", () => {
    const html = renderEmail({ status: "success", title: "Pipeline terminé", generatedAt: FIXED });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("🤾 ffhandball");
    expect(html).toContain("Pipeline terminé");
    expect(html).toContain("#16a34a"); // accent succès
    expect(html).toContain("2026-06-03 07:00 UTC");
  });

  it("échappe titre et intro (pas d'injection HTML)", () => {
    const html = renderEmail({ status: "info", title: 'A <b> & "x"', intro: "<script>alert(1)</script>", generatedAt: FIXED });
    expect(html).toContain("A &lt;b&gt; &amp; &quot;x&quot;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("chaque statut a sa couleur d'accent", () => {
    expect(renderEmail({ status: "warning", title: "t", generatedAt: FIXED })).toContain("#d97706");
    expect(renderEmail({ status: "failure", title: "t", generatedAt: FIXED })).toContain("#dc2626");
    expect(renderEmail({ status: "info", title: "t", generatedAt: FIXED })).toContain("#2563eb");
  });

  it("inclut intro/body/footer quand fournis", () => {
    const html = renderEmail({
      status: "info",
      title: "t",
      intro: "bonjour",
      bodyHtml: "<p>corps</p>",
      footerNote: "pied",
      generatedAt: FIXED,
    });
    expect(html).toContain("bonjour");
    expect(html).toContain("<p>corps</p>");
    expect(html).toContain("pied");
  });
});

describe("composants", () => {
  it("emailTable échappe les cellules et rend les lignes", () => {
    const t = emailTable(["A", "B"], [["x", "y<z"]]);
    expect(t).toContain("<table");
    expect(t).toContain("y&lt;z");
  });

  it("emailList échappe les items", () => {
    expect(emailList(["a<b", "c"])).toContain("a&lt;b");
  });

  it("emailCallout garde le HTML fourni (non échappé)", () => {
    expect(emailCallout("<strong>hi</strong>", "failure")).toContain("<strong>hi</strong>");
  });

  it("emailCodeBlock échappe le contenu", () => {
    expect(emailCodeBlock("<oops> & co")).toContain("&lt;oops&gt; &amp; co");
  });

  it("escapeHtml gère toutes les entités", () => {
    expect(escapeHtml('<>&"')).toBe("&lt;&gt;&amp;&quot;");
  });
});
