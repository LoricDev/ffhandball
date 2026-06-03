// src/etl/feuilles-match.etl.ts
import { query } from "@/db/client.js";
import { iterateRawBatched } from "@/etl/shared/iterate-raw-batched.js";
import { rawFeuilleMatchPayloadSchema, type RawFeuilleMatchPayload } from "@/schemas/feuille-match.schema.js";
import { logger } from "@/lib/logger.js";
import { loadMatchByFdmIndex, type MatchRef } from "@/etl/shared/lookups.js";

interface RawFdmRow {
  id: number;
  natural_key: string;
  payload: unknown;
}

export interface EtlReport {
  etl_run_id: number;
  rows_read: number;
  rows_validated: number;
  rows_rejected: number;
  rows_inserted: number;
  rows_updated: number;
  rows_noop: number;
  warnings_count: number;
}

export async function runFeuillesMatchEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('feuilles_match', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report: EtlReport = {
    etl_run_id,
    rows_read: 0, rows_validated: 0, rows_rejected: 0,
    rows_inserted: 0, rows_updated: 0, rows_noop: 0, warnings_count: 0,
  };

  try {
    // Préchargement de l'index fdm_code → match (1 requête) au lieu d'un SELECT par FdM.
    const matchIndex = await loadMatchByFdmIndex();

    for await (const row of iterateRawBatched("raw.feuilles_match", saison)) {
      report.rows_read++;
      await processOneFdm(row, etl_run_id, report, matchIndex);
    }

    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status = 'success',
         rows_read = $2, rows_validated = $3, rows_rejected = $4,
         rows_inserted = $5, rows_updated = $6, rows_noop = $7, warnings_count = $8
       WHERE id = $1`,
      [etl_run_id, report.rows_read, report.rows_validated, report.rows_rejected,
       report.rows_inserted, report.rows_updated, report.rows_noop, report.warnings_count],
    );

    logger.info(report, "feuilles_match ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}

// Valide puis insère une seule FdM (cascade transactionnelle joueurs + compositions + actions).
// Mute `report` en place. Ne propage pas les erreurs de cascade : elles sont consignées en warning.
async function processOneFdm(
  row: RawFdmRow,
  etl_run_id: number,
  report: EtlReport,
  matchIndex: Map<string, MatchRef>,
): Promise<void> {
  const parsed = rawFeuilleMatchPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    await query(
      `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
       VALUES ($1,'feuilles_match',$2,$3,$4,$5)`,
      [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
    );
    report.rows_rejected++;
    return;
  }
  report.rows_validated++;

  const fdm: RawFeuilleMatchPayload = parsed.data;

  // Étape 1 : résoudre match_id via fdm_code (index préchargé, pas de requête)
  const m = matchIndex.get(fdm.fdm_code);
  if (!m) {
    await query(
      `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
       VALUES ($1,'feuilles_match',$2,$3)`,
      [etl_run_id, fdm.fdm_code, `match avec fdm_code='${fdm.fdm_code}' introuvable en core.matchs`],
    );
    report.warnings_count++;
    return;
  }
  const { id: match_id, equipe_dom_id, equipe_ext_id } = m;

  // Transaction par FdM
  await query("BEGIN");
  try {
    // Étape 2 : UPDATE core.matchs.fdm_url
    await query(
      `UPDATE core.matchs SET fdm_url = $1 WHERE id = $2 AND (fdm_url IS NULL OR fdm_url IS DISTINCT FROM $1)`,
      [fdm.source_url, match_id],
    );

    // Étape 2bis : dériver le score depuis la FdM (la FdM est la source du résultat et est
    // disponible AVANT que le serveur ffhandball ne publie le score, en général le lendemain).
    // recevant → domicile, visiteur → extérieur (mapping non ambigu). On ne remplit QUE si le
    // score est encore absent : on ne clobbere jamais un score déjà publié/corrigé par ffhandball
    // (cas « score saisi à part suite à un problème de FdM »).
    if (fdm.score_recevant !== null && fdm.score_visiteur !== null) {
      const scoreRes = await query(
        `UPDATE core.matchs
            SET score_dom = $1, score_ext = $2,
                score_mt_dom = COALESCE($3, score_mt_dom),
                score_mt_ext = COALESCE($4, score_mt_ext),
                statut = 'joue',
                last_seen_at = now(),
                updated_at = now()
          WHERE id = $5 AND (score_dom IS NULL OR score_ext IS NULL)`,
        [fdm.score_recevant, fdm.score_visiteur, fdm.score_mi_temps_recevant, fdm.score_mi_temps_visiteur, match_id],
      );
      if (scoreRes.rowCount && scoreRes.rowCount > 0) {
        logger.debug(
          { fdm_code: fdm.fdm_code, score: `${fdm.score_recevant}-${fdm.score_visiteur}` },
          "score dérivé de la FdM (avant publication ffhandball)",
        );
      }
    }

    // Étape 3 : UPSERT joueurs (par numero_licence) + build index cote-maillot → joueur_id
    const numeroMailletToJoueurId = new Map<string, number>(); // ${cote}-${numero_maillot} → joueur_id

    const allJoueurs: Array<{ joueur: (typeof fdm.composition_recevant)[0]; cote: "recevant" | "visiteur" }> = [
      ...fdm.composition_recevant.map((j) => ({ joueur: j, cote: "recevant" as const })),
      ...fdm.composition_visiteur.map((j) => ({ joueur: j, cote: "visiteur" as const })),
    ];

    for (const { joueur: j, cote } of allJoueurs) {
      const r = await query<{ id: number }>(
        `INSERT INTO core.joueurs (numero_licence, nom, prenom, last_seen_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (numero_licence) DO UPDATE
         SET nom = EXCLUDED.nom, prenom = EXCLUDED.prenom, last_seen_at = now(),
             updated_at = CASE WHEN core.joueurs.nom IS DISTINCT FROM EXCLUDED.nom
                               OR core.joueurs.prenom IS DISTINCT FROM EXCLUDED.prenom
                          THEN now() ELSE core.joueurs.updated_at END
         RETURNING id`,
        [j.numero_licence, j.nom, j.prenom],
      );
      const joueur_id = r.rows[0]!.id;

      // Index par côté+maillot pour résoudre les actions
      if (j.numero_maillot !== null) {
        numeroMailletToJoueurId.set(`${cote}-${j.numero_maillot}`, joueur_id);
      }

      // Étape 4 : UPSERT match_compositions
      const equipe_id = cote === "recevant" ? equipe_dom_id : equipe_ext_id;
      await query(
        `INSERT INTO core.match_compositions (
           match_id, joueur_id, equipe_id, numero_maillot,
           titulaire, capitaine, gardien,
           but_count, exclusion_2min_count, carton_jaune, carton_rouge,
           type_licence, tirs_count, arrets_count,
           sept_metres_tentes, sept_metres_reussis,
           avertissement, disqualifie
         )
         VALUES ($1,$2,$3,$4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (match_id, joueur_id) DO UPDATE
         SET equipe_id = EXCLUDED.equipe_id,
             numero_maillot = EXCLUDED.numero_maillot,
             capitaine = EXCLUDED.capitaine,
             gardien = EXCLUDED.gardien,
             but_count = EXCLUDED.but_count,
             exclusion_2min_count = EXCLUDED.exclusion_2min_count,
             carton_jaune = EXCLUDED.carton_jaune,
             type_licence = COALESCE(EXCLUDED.type_licence, core.match_compositions.type_licence),
             tirs_count = EXCLUDED.tirs_count,
             arrets_count = EXCLUDED.arrets_count,
             sept_metres_tentes = EXCLUDED.sept_metres_tentes,
             sept_metres_reussis = EXCLUDED.sept_metres_reussis,
             avertissement = EXCLUDED.avertissement,
             disqualifie = EXCLUDED.disqualifie,
             updated_at = now()`,
        [
          match_id, joueur_id, equipe_id, j.numero_maillot,
          j.capitaine, j.gardien,
          j.buts ?? 0, j.exclusions_2min ?? 0, j.avertissement, j.disqualifie,
          j.type_licence,
          j.tirs ?? 0, j.arrets ?? 0,
          j.sept_metres_tentes ?? 0, j.sept_metres_reussis ?? 0,
          j.avertissement, j.disqualifie,
        ],
      );
    }

    // Étape 5 : UPSERT match_actions
    for (const a of fdm.actions) {
      const key = a.cote && a.numero_maillot !== null && a.numero_maillot !== undefined
        ? `${a.cote}-${a.numero_maillot}`
        : null;
      const joueur_id = key ? (numeroMailletToJoueurId.get(key) ?? null) : null;

      await query(
        `INSERT INTO core.match_actions (
           match_id, ordre, periode, temps_seconds,
           score_recevant, score_visiteur,
           type_action, cote, joueur_id, numero_maillot,
           acteur_role, description_brute
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (match_id, ordre) DO UPDATE
         SET periode = EXCLUDED.periode,
             temps_seconds = EXCLUDED.temps_seconds,
             score_recevant = EXCLUDED.score_recevant,
             score_visiteur = EXCLUDED.score_visiteur,
             type_action = EXCLUDED.type_action,
             cote = EXCLUDED.cote,
             joueur_id = COALESCE(EXCLUDED.joueur_id, core.match_actions.joueur_id),
             numero_maillot = EXCLUDED.numero_maillot,
             acteur_role = EXCLUDED.acteur_role,
             description_brute = EXCLUDED.description_brute`,
        [
          match_id, a.ordre, a.periode, a.temps_seconds,
          a.score_recevant, a.score_visiteur,
          a.type_action, a.cote ?? null, joueur_id, a.numero_maillot ?? null,
          a.acteur_role ?? null, a.description_brute,
        ],
      );
    }

    await query("COMMIT");
    report.rows_inserted++;
  } catch (e) {
    await query("ROLLBACK");
    logger.warn({ fdm_code: fdm.fdm_code, err: String(e) }, "FdM ETL transaction rolled back");
    await query(
      `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
       VALUES ($1,'feuilles_match',$2,$3)`,
      [etl_run_id, fdm.fdm_code, `cascade error: ${String(e).slice(0, 200)}`],
    );
    report.warnings_count++;
  }
}
