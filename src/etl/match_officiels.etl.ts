// src/etl/match_officiels.etl.ts
import { query } from "@/db/client.js";
import { logger } from "@/lib/logger.js";

interface RawMatchOfficielsRow {
  ext_rencontre_id: string;
  arbitre1_id: string | null;
  arbitre2_id: string | null;
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

async function resolveMatchId(extRencontreId: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.matchs WHERE id_ffhb_match = $1`,
    [extRencontreId],
  );
  return r.rows[0]?.id ?? null;
}

async function resolveArbitreId(idFfhb: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.arbitres WHERE id_ffhb = $1`,
    [idFfhb],
  );
  return r.rows[0]?.id ?? null;
}

export async function runMatchOfficielsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('match_officiels', $1) RETURNING id`,
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
    // DISTINCT ON pour la dernière version raw par match
    const rawRes = await query<RawMatchOfficielsRow>(
      `SELECT DISTINCT ON (natural_key)
              payload->>'ext_rencontre_id' AS ext_rencontre_id,
              payload->>'arbitre1_id'      AS arbitre1_id,
              payload->>'arbitre2_id'      AS arbitre2_id
         FROM raw.matchs
        WHERE saison = $1
          AND (payload->>'arbitre1_id' IS NOT NULL OR payload->>'arbitre2_id' IS NOT NULL)
        ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRes.rowCount ?? 0;

    for (const row of rawRes.rows) {
      if (!row.ext_rencontre_id) continue;
      report.rows_validated++;

      const match_id = await resolveMatchId(row.ext_rencontre_id);
      if (match_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'match_officiels',$2,$3)`,
          [etl_run_id, row.ext_rencontre_id, `match ${row.ext_rencontre_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      for (const [field, role] of [
        ["arbitre1_id", "arbitre_1"] as const,
        ["arbitre2_id", "arbitre_2"] as const,
      ]) {
        const idFfhb = field === "arbitre1_id" ? row.arbitre1_id : row.arbitre2_id;
        if (!idFfhb || idFfhb === "") continue;

        const arbitre_id = await resolveArbitreId(idFfhb);
        if (arbitre_id === null) {
          await query(
            `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
             VALUES ($1,'match_officiels',$2,$3)`,
            [
              etl_run_id,
              `${row.ext_rencontre_id}-${role}`,
              `arbitre ${idFfhb} introuvable`,
            ],
          );
          report.warnings_count++;
          continue;
        }

        const insertRes = await query<{ inserted: boolean }>(
          `INSERT INTO core.match_officiels (match_id, arbitre_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (match_id, arbitre_id, role) DO NOTHING
           RETURNING (xmax = 0) AS inserted`,
          [match_id, arbitre_id, role],
        );

        if (insertRes.rowCount && insertRes.rowCount > 0 && insertRes.rows[0]!.inserted) {
          report.rows_inserted++;
        } else {
          report.rows_noop++;
        }
      }
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'success',
             rows_read=$2, rows_validated=$3, rows_rejected=$4,
             rows_inserted=$5, rows_updated=$6, rows_noop=$7, warnings_count=$8
         WHERE id = $1`,
      [
        etl_run_id,
        report.rows_read, report.rows_validated, report.rows_rejected,
        report.rows_inserted, report.rows_updated, report.rows_noop, report.warnings_count,
      ],
    );

    logger.info(report, "match_officiels ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
