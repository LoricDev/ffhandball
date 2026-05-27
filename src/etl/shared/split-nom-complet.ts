// src/etl/shared/split-nom-complet.ts
export function splitNomComplet(nomComplet: string): { nom: string; prenom: string | null } {
  const trimmed = nomComplet.trim();
  if (trimmed === "") {
    throw new Error("Empty nom_complet");
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { nom: parts[0]!, prenom: null };
  }
  return { nom: parts[0]!, prenom: parts.slice(1).join(" ") };
}
