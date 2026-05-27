// src/etl/phases.etl.ts
import { query } from "@/db/client.js";
import { rawPhasePayloadSchema, type RawPhasePayload } from "@/schemas/phase.schema.js";
import { logger } from "@/lib/logger.js";

interface RawPhaseRow {
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

async function resolveCompetitionId(
  idFfhb: string,
  saison: string,
): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.competitions WHERE id_ffhb = $1 AND saison_code = $2`,
    [idFfhb, saison],
  );
  return r.rows[0]?.id ?? null;
}

export async function runPhasesEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('phases', $1) RETURNING id`,
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
    const rawRows = await query<RawPhaseRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.phases
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawPhasePayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'phases',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawPhasePayload = parsed.data;
      const competition_id = await resolveCompetitionId(p.ext_competition_id, saison);
      if (competition_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'phases',$2,$3)`,
          [etl_run_id, p.ext_phase_id, `competition ${p.ext_competition_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.phases (id_ffhb, competition_id, nom, saison_code, last_seen_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (id_ffhb, saison_code) DO UPDATE
         SET competition_id = EXCLUDED.competition_id,
             nom = EXCLUDED.nom,
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.phases.competition_id IS DISTINCT FROM EXCLUDED.competition_id
                 OR core.phases.nom IS DISTINCT FROM EXCLUDED.nom
               THEN now()
               ELSE core.phases.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.ext_phase_id, competition_id, p.nom, saison],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'success',
             rows_read=$2, rows_validated=$3, rows_rejected=$4,
             rows_inserted=$5, rows_updated=$6, rows_noop=$7, warnings_count=$8
         WHERE id = $1`,
      [
        etl_run_id,
        report.rows_read,
        report.rows_validated,
        report.rows_rejected,
        report.rows_inserted,
        report.rows_updated,
        report.rows_noop,
        report.warnings_count,
      ],
    );

    logger.info(report, "phases ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
