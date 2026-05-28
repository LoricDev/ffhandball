// src/etl/matchs.etl.ts
import { query } from "@/db/client.js";
import { rawMatchPayloadSchema, type RawMatchPayload } from "@/schemas/match.schema.js";
import { logger } from "@/lib/logger.js";

interface RawMatchRow {
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

async function resolvePouleId(idFfhb: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.poules WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

async function resolveEquipeId(idFfhb: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.equipes WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

function deduceStatut(scoreDom: number | null | undefined, scoreExt: number | null | undefined): "a_jouer" | "joue" {
  return scoreDom !== null && scoreDom !== undefined &&
         scoreExt !== null && scoreExt !== undefined
    ? "joue"
    : "a_jouer";
}

function deduceHeureEstimee(dateHeure: string): boolean {
  return /T00:00:00/.test(dateHeure);
}

export async function runMatchsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('matchs', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report: EtlReport = {
    etl_run_id,
    rows_read: 0,
    rows_validated: 0,
    rows_rejected: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_noop: 0,
    warnings_count: 0,
  };

  try {
    const rawRows = await query<RawMatchRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.matchs
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawMatchPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'matchs',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawMatchPayload = parsed.data;

      const poule_id = await resolvePouleId(p.ext_poule_id, saison);
      if (poule_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'matchs',$2,$3)`,
          [etl_run_id, p.ext_rencontre_id, `poule ${p.ext_poule_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const equipe_dom_id = await resolveEquipeId(p.ext_equipe_dom_id, saison);
      if (equipe_dom_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'matchs',$2,$3)`,
          [etl_run_id, p.ext_rencontre_id, `equipe_dom ${p.ext_equipe_dom_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const equipe_ext_id = await resolveEquipeId(p.ext_equipe_ext_id, saison);
      if (equipe_ext_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'matchs',$2,$3)`,
          [etl_run_id, p.ext_rencontre_id, `equipe_ext ${p.ext_equipe_ext_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      if (equipe_dom_id === equipe_ext_id) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'matchs',$2,$3)`,
          [etl_run_id, p.ext_rencontre_id, `equipes identiques après résolution FK`],
        );
        report.warnings_count++;
        continue;
      }

      const statut = deduceStatut(p.score_dom, p.score_ext);
      const heure_estimee = deduceHeureEstimee(p.date_heure);

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.matchs (
           id_ffhb_match, poule_id, equipe_dom_id, equipe_ext_id,
           date_heure, heure_estimee,
           score_dom, score_ext, score_mt_dom, score_mt_ext,
           statut, journee, equipement_id, fdm_code, last_seen_at
         )
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
         ON CONFLICT (id_ffhb_match) DO UPDATE
         SET poule_id      = EXCLUDED.poule_id,
             equipe_dom_id = EXCLUDED.equipe_dom_id,
             equipe_ext_id = EXCLUDED.equipe_ext_id,
             date_heure    = EXCLUDED.date_heure,
             heure_estimee = EXCLUDED.heure_estimee,
             score_dom     = COALESCE(EXCLUDED.score_dom, core.matchs.score_dom),
             score_ext     = COALESCE(EXCLUDED.score_ext, core.matchs.score_ext),
             score_mt_dom  = COALESCE(EXCLUDED.score_mt_dom, core.matchs.score_mt_dom),
             score_mt_ext  = COALESCE(EXCLUDED.score_mt_ext, core.matchs.score_mt_ext),
             statut        = EXCLUDED.statut,
             journee       = EXCLUDED.journee,
             equipement_id = COALESCE(EXCLUDED.equipement_id, core.matchs.equipement_id),
             fdm_code      = COALESCE(EXCLUDED.fdm_code, core.matchs.fdm_code),
             last_seen_at  = now(),
             updated_at    = CASE
               WHEN core.matchs.poule_id      IS DISTINCT FROM EXCLUDED.poule_id
                 OR core.matchs.equipe_dom_id IS DISTINCT FROM EXCLUDED.equipe_dom_id
                 OR core.matchs.equipe_ext_id IS DISTINCT FROM EXCLUDED.equipe_ext_id
                 OR core.matchs.date_heure    IS DISTINCT FROM EXCLUDED.date_heure
                 OR core.matchs.heure_estimee IS DISTINCT FROM EXCLUDED.heure_estimee
                 OR (EXCLUDED.score_dom IS NOT NULL AND core.matchs.score_dom IS DISTINCT FROM EXCLUDED.score_dom)
                 OR (EXCLUDED.score_ext IS NOT NULL AND core.matchs.score_ext IS DISTINCT FROM EXCLUDED.score_ext)
                 OR (EXCLUDED.score_mt_dom IS NOT NULL AND core.matchs.score_mt_dom IS DISTINCT FROM EXCLUDED.score_mt_dom)
                 OR (EXCLUDED.score_mt_ext IS NOT NULL AND core.matchs.score_mt_ext IS DISTINCT FROM EXCLUDED.score_mt_ext)
                 OR core.matchs.statut        IS DISTINCT FROM EXCLUDED.statut
                 OR core.matchs.journee       IS DISTINCT FROM EXCLUDED.journee
                 OR (EXCLUDED.equipement_id IS NOT NULL AND core.matchs.equipement_id IS DISTINCT FROM EXCLUDED.equipement_id)
                 OR (EXCLUDED.fdm_code IS NOT NULL AND core.matchs.fdm_code IS DISTINCT FROM EXCLUDED.fdm_code)
               THEN now()
               ELSE core.matchs.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [
          p.ext_rencontre_id,
          poule_id,
          equipe_dom_id,
          equipe_ext_id,
          p.date_heure,
          heure_estimee,
          p.score_dom ?? null,
          p.score_ext ?? null,
          p.score_mt_dom ?? null,
          p.score_mt_ext ?? null,
          statut,
          p.journee,
          p.equipement_id ?? null,
          p.fdm_code ?? null,
        ],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'success',
             rows_read = $2, rows_validated = $3, rows_rejected = $4,
             rows_inserted = $5, rows_updated = $6, rows_noop = $7, warnings_count = $8
         WHERE id = $1`,
      [
        etl_run_id,
        report.rows_read, report.rows_validated, report.rows_rejected,
        report.rows_inserted, report.rows_updated, report.rows_noop, report.warnings_count,
      ],
    );

    logger.info(report, "matchs ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
