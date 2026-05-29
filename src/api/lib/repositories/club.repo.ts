// src/api/lib/repositories/club.repo.ts
import { query } from "@/db/client.js";
import type { RosterJoueurItem } from "@/api/lib/repositories/equipe.repo.js";

export interface ClubClassementItem {
  equipe: { id_ffhb: string; nom: string };
  poule: { id_ffhb: string; nom: string };
  competition: { id_ffhb: string; nom: string; niveau: string | null };
  position: number;
  points: number;
  joues: number;
  gagnes: number;
  nuls: number;
  perdus: number;
  buts_pour: number;
  buts_contre: number;
  difference: number;
}

export interface ClubListItem {
  id_ffhb: string;
  code_ffhb: string | null;
  nom: string;
  ville: string | null;
  departement_code: string | null;
  telephone: string | null;
  email: string | null;
  site_web: string | null;
}

export interface ClubDetail extends ClubListItem {
  sigle: string | null;
  adresse_correspondance: string | null;
  latitude: number | null;
  longitude: number | null;
  logo_club: string | null;
  effectif_estime: number | null;
  salle_principale: {
    id_ffhb: string;
    nom: string;
    adresse: string | null;
    code_postal: string | null;
    ville: string | null;
  } | null;
}

export interface ClubListOptions {
  q?: string;
  departement?: string;
  limit: number;
  offset: number;
}

export async function listClubs(opts: ClubListOptions): Promise<{ data: ClubListItem[]; total: number }> {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];

  if (opts.q && opts.q.length >= 2) {
    params.push(opts.q);
    where.push(`$${params.length} <% c.nom`);
  }
  if (opts.departement) {
    params.push(opts.departement);
    where.push(`d.code = $${params.length}`);
  }

  const whereClause = where.join(" AND ");

  // Count total
  const countSql = `
    SELECT count(*)::int AS total
      FROM core.clubs c
      LEFT JOIN core.departements d ON d.id = c.departement_id
     WHERE ${whereClause}`;
  const countRes = await query<{ total: number }>(countSql, params);
  const total = countRes.rows[0]!.total;

  // Page
  params.push(opts.limit);
  params.push(opts.offset);
  const dataSql = `
    SELECT c.id_ffhb, c.code_ffhb, c.nom, c.ville, d.code AS departement_code,
           c.telephone, c.email, c.site_web
      FROM core.clubs c
      LEFT JOIN core.departements d ON d.id = c.departement_id
     WHERE ${whereClause}
     ORDER BY c.nom
     LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const dataRes = await query<ClubListItem>(dataSql, params);
  return { data: dataRes.rows, total };
}

export async function getClubByIdFfhb(idFfhb: string): Promise<ClubDetail | null> {
  // Résolution par id_ffhb (= id_club monclub) OU par code_ffhb (code FFHB 7 chiffres public).
  const sql = `
    SELECT
      c.id_ffhb, c.code_ffhb, c.nom, c.ville, d.code AS departement_code,
      c.telephone, c.email, c.site_web,
      c.sigle, c.adresse_correspondance, c.latitude, c.longitude,
      c.logo_club, c.effectif_estime,
      s.id_ffhb AS salle_id_ffhb, s.nom AS salle_nom, s.adresse AS salle_adresse,
      s.code_postal AS salle_cp, s.ville AS salle_ville
    FROM core.clubs c
    LEFT JOIN core.departements d ON d.id = c.departement_id
    LEFT JOIN core.salles s ON s.id = c.salle_principale_id
    WHERE c.id_ffhb = $1 OR c.code_ffhb = $1`;
  const r = await query<Record<string, unknown>>(sql, [idFfhb]);
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  const salle = row.salle_id_ffhb
    ? {
        id_ffhb: row.salle_id_ffhb as string,
        nom: row.salle_nom as string,
        adresse: row.salle_adresse as string | null,
        code_postal: row.salle_cp as string | null,
        ville: row.salle_ville as string | null,
      }
    : null;
  return {
    id_ffhb: row.id_ffhb as string,
    code_ffhb: row.code_ffhb as string | null,
    nom: row.nom as string,
    ville: row.ville as string | null,
    departement_code: row.departement_code as string | null,
    telephone: row.telephone as string | null,
    email: row.email as string | null,
    site_web: row.site_web as string | null,
    sigle: row.sigle as string | null,
    adresse_correspondance: row.adresse_correspondance as string | null,
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    logo_club: row.logo_club as string | null,
    effectif_estime: row.effectif_estime as number | null,
    salle_principale: salle,
  };
}

/** Joueurs licenciés d'un club (préfixe licence = code_ffhb), avec matchs/buts joués. */
export async function listClubJoueurs(code7: string | null): Promise<RosterJoueurItem[]> {
  if (!code7) return [];
  const r = await query<RosterJoueurItem>(
    `SELECT j.numero_licence, j.nom, j.prenom,
            count(DISTINCT mc.match_id)::int AS matchs,
            coalesce(sum(mc.but_count), 0)::int AS buts
       FROM core.joueurs j
       LEFT JOIN core.match_compositions mc ON mc.joueur_id = j.id
      WHERE left(j.numero_licence, 7) = $1
      GROUP BY j.id, j.numero_licence, j.nom, j.prenom
      ORDER BY buts DESC, j.nom ASC`,
    [code7],
  );
  return r.rows;
}

/** Classements de toutes les équipes propres d'un club (dernier snapshot par équipe). */
export async function listClubClassements(clubIdFfhb: string, saison: string): Promise<ClubClassementItem[]> {
  const r = await query<{
    equipe_id_ffhb: string;
    equipe_nom: string;
    poule_id_ffhb: string;
    poule_nom: string;
    comp_id_ffhb: string;
    comp_nom: string;
    comp_niveau: string | null;
    position: number;
    points: number;
    joues: number;
    gagnes: number;
    nuls: number;
    perdus: number;
    buts_pour: number;
    buts_contre: number;
    difference: number;
  }>(
    `SELECT DISTINCT ON (e.id)
            e.id_ffhb AS equipe_id_ffhb, e.nom AS equipe_nom,
            po.id_ffhb AS poule_id_ffhb, po.nom AS poule_nom,
            c.id_ffhb AS comp_id_ffhb, c.nom AS comp_nom, c.niveau AS comp_niveau,
            cl.position, cl.points, cl.joues, cl.gagnes, cl.nuls, cl.perdus,
            cl.buts_pour, cl.buts_contre, cl.difference
       FROM core.equipes e
       JOIN core.classements cl ON cl.equipe_id = e.id
       JOIN core.poules po ON po.id = cl.poule_id
       JOIN core.phases ph ON ph.id = po.phase_id
       JOIN core.competitions c ON c.id = ph.competition_id
      WHERE e.ext_structure_id = $1 AND e.saison_code = $2
      ORDER BY e.id, cl.capture_date DESC`,
    [clubIdFfhb, saison],
  );
  return r.rows.map((row) => ({
    equipe: { id_ffhb: row.equipe_id_ffhb, nom: row.equipe_nom },
    poule: { id_ffhb: row.poule_id_ffhb, nom: row.poule_nom },
    competition: { id_ffhb: row.comp_id_ffhb, nom: row.comp_nom, niveau: row.comp_niveau },
    position: row.position,
    points: row.points,
    joues: row.joues,
    gagnes: row.gagnes,
    nuls: row.nuls,
    perdus: row.perdus,
    buts_pour: row.buts_pour,
    buts_contre: row.buts_contre,
    difference: row.difference,
  }));
}
