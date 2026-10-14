import { describe, it, expect } from "vitest";
import { buildStatus } from "@/api/lib/repositories/status.repo.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function allFresh(): Map<string, Date | null> {
  return new Map([
    ["matchs", hoursAgo(3)], ["classements", hoursAgo(9)], ["feuilles-match", hoursAgo(5)],
    ["stats-joueurs", hoursAgo(8)], ["competitions", hoursAgo(48)], ["clubs", hoursAgo(48)],
  ]);
}

describe("buildStatus", () => {
  it("opérationnel quand tout est à jour", () => {
    const s = buildStatus(allFresh(), true, NOW);
    expect(s.statut).toBe("operationnel");
    expect(s.donnees.every((d) => d.etat === "ok")).toBe(true);
    expect(s.donnees[0]).toMatchObject({ key: "matchs", age_heures: 3 });
  });

  it("dégradé si un jeu de données quotidien a plus de 36 h", () => {
    const m = allFresh(); m.set("matchs", hoursAgo(40));
    const s = buildStatus(m, true, NOW);
    expect(s.statut).toBe("degrade");
    expect(s.donnees.find((d) => d.key === "matchs")!.etat).toBe("retard");
  });

  it("les référentiels hebdomadaires tolèrent 9 jours", () => {
    const m = allFresh(); m.set("clubs", hoursAgo(8 * 24));
    expect(buildStatus(m, true, NOW).statut).toBe("operationnel");
    m.set("clubs", hoursAgo(10 * 24));
    expect(buildStatus(m, true, NOW).statut).toBe("degrade");
  });

  it("jeu de données jamais capturé → inconnu → dégradé", () => {
    const m = allFresh(); m.delete("stats-joueurs");
    const s = buildStatus(m, true, NOW);
    expect(s.donnees.find((d) => d.key === "stats_joueurs")).toMatchObject({ etat: "inconnu", derniere_maj: null });
    expect(s.statut).toBe("degrade");
  });

  it("panne si la base est indisponible", () => {
    const s = buildStatus(new Map(), false, NOW);
    expect(s.statut).toBe("panne");
    expect(s.base_de_donnees).toBe("indisponible");
  });
});
