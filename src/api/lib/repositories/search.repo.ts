// src/api/lib/repositories/search.repo.ts
import { query } from "@/db/client.js";

export interface SearchResult {
  type: "club" | "equipe" | "joueur";
  id_ffhb: string;
  nom: string;
  ville: string | null;
  score: number;
}

export interface SearchOptions {
  q: string;
  type: "all" | "clubs" | "equipes" | "joueurs";
  saison?: string;
  limit: number;
}

export async function search(opts: SearchOptions): Promise<SearchResult[]> {
  const { q, type, limit } = opts;
  const saison = opts.saison ?? "2025-2026";

  if (type === "clubs") {
    const r = await query<SearchResult>(
      `SELECT id_ffhb, nom, ville, 'club' AS type, word_similarity($1, nom) AS score
         FROM core.clubs
        WHERE $1 <% nom
        ORDER BY score DESC
        LIMIT $2`,
      [q, limit],
    );
    return r.rows;
  }

  if (type === "equipes") {
    const r = await query<SearchResult>(
      `SELECT id_ffhb, nom, NULL::text AS ville, 'equipe' AS type, word_similarity($1, nom) AS score
         FROM core.equipes
        WHERE $1 <% nom AND saison_code = $2
        ORDER BY score DESC
        LIMIT $3`,
      [q, saison, limit],
    );
    return r.rows;
  }

  if (type === "joueurs") {
    const r = await query<SearchResult>(
      `SELECT numero_licence AS id_ffhb, nom || ' ' || prenom AS nom, NULL::text AS ville,
              'joueur' AS type, word_similarity($1, nom || ' ' || prenom) AS score
         FROM core.joueurs
        WHERE $1 <% (nom || ' ' || prenom)
        ORDER BY score DESC
        LIMIT $2`,
      [q, limit],
    );
    return r.rows;
  }

  // type === "all" — UNION ALL
  const r = await query<SearchResult>(
    `SELECT id_ffhb, nom, ville, 'club' AS type, word_similarity($1, nom) AS score
       FROM core.clubs WHERE $1 <% nom
     UNION ALL
     SELECT id_ffhb, nom, NULL::text AS ville, 'equipe' AS type, word_similarity($1, nom) AS score
       FROM core.equipes WHERE $1 <% nom AND saison_code = $2
     UNION ALL
     SELECT numero_licence AS id_ffhb, nom || ' ' || prenom AS nom, NULL::text AS ville,
            'joueur' AS type, word_similarity($1, nom || ' ' || prenom) AS score
       FROM core.joueurs WHERE $1 <% (nom || ' ' || prenom)
     ORDER BY score DESC
     LIMIT $3`,
    [q, saison, limit],
  );
  return r.rows;
}
