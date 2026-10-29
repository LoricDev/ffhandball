// src/api/lib/club-groupes.ts — groupes (équipes réelles) d'un club pour une saison, partagés par tous les endpoints club.
import { grouperEquipes, type GroupeEquipes } from "@/api/lib/equipe-groupes.js";
import { listClubEquipesAvecPartenaires } from "@/api/lib/repositories/equipe.repo.js";
import { getOverrides } from "@/api/lib/repositories/equipe-overrides.repo.js";

/** Un groupe sans la liste de ses inscriptions : ce qu'on met dans `meta.groupes` des autres endpoints. */
export type GroupeRef = Omit<GroupeEquipes, "equipes" | "competitions">;

export function toGroupeRef({ cle, categorie, sexe, rang, entente, libelle }: GroupeEquipes): GroupeRef {
  return { cle, categorie, sexe, rang, entente, libelle };
}

export interface ClubGroupes {
  groupes: GroupeRef[];
  /** id FFHB d'équipe (inscription) → clé de groupe. Absent = inscription exclue par une correction manuelle. */
  cleParEquipe: Map<string, string>;
}

/** Mêmes équipes, mêmes corrections manuelles et même regroupement que `/clubs/{id}/equipes?grouper=true`. */
export async function resolveClubGroupes(
  club: { id_ffhb: string; code_ffhb: string | null; nom: string },
  saison: string,
): Promise<ClubGroupes> {
  const inscriptions = await listClubEquipesAvecPartenaires(club, saison, { include_ententes: true });
  const groupes = grouperEquipes(inscriptions, await getOverrides(inscriptions.map((e) => e.id_ffhb)));
  const cleParEquipe = new Map<string, string>();
  for (const g of groupes) for (const e of g.equipes) cleParEquipe.set(e.id_ffhb, g.cle);
  return { groupes: groupes.map(toGroupeRef), cleParEquipe };
}
