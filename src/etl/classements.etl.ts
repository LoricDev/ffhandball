// src/etl/classements.etl.ts
import { query } from "@/db/client.js";
import { rawClassementPayloadSchema, type RawClassementPayload } from "@/schemas/classement.schema.js";
import { logger } from "@/lib/logger.js";

interface RawClassementRow {
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

export async function runClassementsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('classements', $1) RETURNING id`,
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
    const rawRows = await query<RawClassementRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.classements
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawClassementPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'classements',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawClassementPayload = parsed.data;

      const poule_id = await resolvePouleId(p.ext_poule_id, saison);
      if (poule_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'classements',$2,$3)`,
          [etl_run_id, p.ext_classement_id, `poule ${p.ext_poule_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const equipe_id = await resolveEquipeId(p.ext_equipe_id, saison);
      if (equipe_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'classements',$2,$3)`,
          [etl_run_id, p.ext_classement_id, `equipe ${p.ext_equipe_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const upsert = await query<{ inserted: boolean }>(
        `INSERT INTO core.classements (
           poule_id, equipe_id, position, points, joues, gagnes, nuls, perdus,
           buts_pour, buts_contre, id_ffhb, dernieres_rencontres, capture_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (poule_id, equipe_id) DO UPDATE
         SET position             = EXCLUDED.position,
             points               = EXCLUDED.points,
             joues                = EXCLUDED.joues,
             gagnes               = EXCLUDED.gagnes,
             nuls                 = EXCLUDED.nuls,
             perdus               = EXCLUDED.perdus,
             buts_pour            = EXCLUDED.buts_pour,
             buts_contre          = EXCLUDED.buts_contre,
             id_ffhb              = COALESCE(EXCLUDED.id_ffhb, core.classements.id_ffhb),
             dernieres_rencontres = COALESCE(EXCLUDED.dernieres_rencontres, core.classements.dernieres_rencontres),
             capture_date         = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          poule_id, equipe_id,
          p.position, p.points, p.joues, p.gagnes, p.nuls, p.perdus,
          p.buts_pour, p.buts_contre,
          p.ext_classement_id,
          p.dernieres_rencontres ?? null,
        ],
      );

      if (upsert.rows[0]!.inserted) report.rows_inserted++;
      else report.rows_updated++;
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

    logger.info(report, "classements ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
