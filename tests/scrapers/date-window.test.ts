import { describe, it, expect } from "vitest";
import { weekendWindow, liveWindow, parseDate, resolveDateWindow } from "@/scrapers/shared/date-window.js";

// Helper : composante locale lisible (YYYY-MM-DD jour).
function iso(d: Date): string {
  const days = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${days[d.getDay()]}`;
}

describe("weekendWindow", () => {
  // 2026-06-06 est un samedi.
  it("un mercredi cible le samedi/dimanche à venir de la même semaine ISO", () => {
    const w = weekendWindow(new Date(2026, 5, 3, 14, 0)); // mer. 3 juin
    expect(iso(w.from)).toBe("2026-06-06 sam");
    expect(iso(w.to)).toBe("2026-06-08 lun");
  });

  it("un samedi cible le samedi courant", () => {
    const w = weekendWindow(new Date(2026, 5, 6, 10, 0)); // sam. 6 juin
    expect(iso(w.from)).toBe("2026-06-06 sam");
    expect(iso(w.to)).toBe("2026-06-08 lun");
  });

  it("un dimanche cible le samedi de la veille (même week-end)", () => {
    const w = weekendWindow(new Date(2026, 5, 7, 18, 0)); // dim. 7 juin
    expect(iso(w.from)).toBe("2026-06-06 sam");
    expect(iso(w.to)).toBe("2026-06-08 lun");
  });

  it("un lundi cible le week-end à venir de la semaine ISO en cours", () => {
    const w = weekendWindow(new Date(2026, 5, 8, 9, 0)); // lun. 8 juin
    expect(iso(w.from)).toBe("2026-06-13 sam");
    expect(iso(w.to)).toBe("2026-06-15 lun");
  });

  it("borne basse à minuit local, fenêtre de 2 jours pleins", () => {
    const w = weekendWindow(new Date(2026, 5, 6, 23, 59));
    expect(w.from.getHours()).toBe(0);
    expect((w.to.getTime() - w.from.getTime()) / 86_400_000).toBe(2);
  });
});

describe("liveWindow", () => {
  const now = new Date(2026, 5, 6, 18, 0); // sam. 18:00

  it("par défaut : now−2h … now+30min", () => {
    const w = liveWindow(now);
    expect(w.from.getTime()).toBe(now.getTime() - 2 * 3600_000);
    expect(w.to.getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  it("inclut un match commencé il y a 1h30 (score final en cours de saisie)", () => {
    const w = liveWindow(now);
    const kickoff = new Date(now.getTime() - 90 * 60_000);
    expect(kickoff >= w.from && kickoff < w.to).toBe(true);
  });

  it("exclut un match commencé il y a 3h", () => {
    const w = liveWindow(now);
    const kickoff = new Date(now.getTime() - 3 * 3600_000);
    expect(kickoff >= w.from).toBe(false);
  });

  it("inclut un match qui démarre dans 20 min, exclut dans 50 min", () => {
    const w = liveWindow(now);
    expect(new Date(now.getTime() + 20 * 60_000) < w.to).toBe(true);
    expect(new Date(now.getTime() + 50 * 60_000) < w.to).toBe(false);
  });

  it("bornes configurables", () => {
    const w = liveWindow(now, { pastMs: 3600_000, futureMs: 0 });
    expect(w.from.getTime()).toBe(now.getTime() - 3600_000);
    expect(w.to.getTime()).toBe(now.getTime());
  });
});

describe("parseDate", () => {
  it("accepte YYYY-MM-DD (minuit local)", () => {
    const d = parseDate("2026-06-06");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(6);
    expect(d.getHours()).toBe(0);
  });

  it("rejette une date invalide", () => {
    expect(() => parseDate("pas-une-date")).toThrow(/invalide/i);
  });
});

describe("resolveDateWindow", () => {
  const now = new Date(2026, 5, 3, 12, 0); // mercredi

  it("renvoie null sans filtre", () => {
    expect(resolveDateWindow({}, now)).toBeNull();
  });

  it("--weekend délègue à weekendWindow", () => {
    const w = resolveDateWindow({ weekend: true }, now);
    expect(w).not.toBeNull();
    expect(iso(w!.from)).toBe("2026-06-06 sam");
  });

  it("--live délègue à liveWindow (prioritaire sur --weekend)", () => {
    const w = resolveDateWindow({ live: true, weekend: true }, now);
    expect(w).not.toBeNull();
    expect(w!.from.getTime()).toBe(now.getTime() - 2 * 3600_000);
    expect(w!.to.getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  it("--from/--to explicites priment sur --weekend", () => {
    const w = resolveDateWindow({ from: "2026-01-10", to: "2026-01-12", weekend: true }, now);
    expect(iso(w!.from)).toBe("2026-01-10 sam");
    expect(iso(w!.to)).toBe("2026-01-12 lun");
  });

  it("rejette une fenêtre où --to <= --from", () => {
    expect(() => resolveDateWindow({ from: "2026-01-12", to: "2026-01-10" }, now)).toThrow(/Fenêtre invalide/);
  });
});
