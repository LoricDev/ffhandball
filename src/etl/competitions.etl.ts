// src/etl/competitions.etl.ts
import { query } from "@/db/client.js";
import {
  rawCompetitionPayloadSchema,
  type RawCompetitionPayload,
} from "@/schemas/competition.schema.js";
import { logger } from "@/lib/logger.js";

interface RawCompetitionRow {
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

export async function runCompetitionsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('competitions', $1) RETURNING id`,
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
    const rawRows = await query<RawCompetitionRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.competitions
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawCompetitionPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets
             (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'competitions',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawCompetitionPayload = parsed.data;

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.competitions
           (id_ffhb, nom, niveau, sexe, categorie_age, saison_code, code, ext_structure_id, detail_url, afficher_stats_joueurs, last_seen_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom = EXCLUDED.nom,
             niveau = EXCLUDED.niveau,
             sexe = COALESCE(EXCLUDED.sexe, core.competitions.sexe),
             saison_code = EXCLUDED.saison_code,
             code = COALESCE(EXCLUDED.code, core.competitions.code),
             ext_structure_id = COALESCE(EXCLUDED.ext_structure_id, core.competitions.ext_structure_id),
             detail_url = COALESCE(EXCLUDED.detail_url, core.competitions.detail_url),
             afficher_stats_joueurs = COALESCE(EXCLUDED.afficher_stats_joueurs, core.competitions.afficher_stats_joueurs),
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.competitions.nom IS DISTINCT FROM EXCLUDED.nom
                 OR core.competitions.niveau IS DISTINCT FROM EXCLUDED.niveau
                 OR (EXCLUDED.sexe IS NOT NULL AND core.competitions.sexe IS DISTINCT FROM EXCLUDED.sexe)
                 OR (EXCLUDED.code IS NOT NULL AND core.competitions.code IS DISTINCT FROM EXCLUDED.code)
                 OR (EXCLUDED.ext_structure_id IS NOT NULL AND core.competitions.ext_structure_id IS DISTINCT FROM EXCLUDED.ext_structure_id)
                 OR (EXCLUDED.detail_url IS NOT NULL AND core.competitions.detail_url IS DISTINCT FROM EXCLUDED.detail_url)
                 OR (EXCLUDED.afficher_stats_joueurs IS NOT NULL AND core.competitions.afficher_stats_joueurs IS DISTINCT FROM EXCLUDED.afficher_stats_joueurs)
               THEN now()
               ELSE core.competitions.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [
          p.ext_competition_id,
          p.nom,
          p.niveau,
          p.sexe ?? null,
          saison,
          p.code ?? null,
          p.ext_structure_id ?? null,
          p.detail_url,
          p.afficher_stats_joueurs ?? null,
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
             rows_read=$2, rows_validated=$3, rows_rejected=$4,
             rows_inserted=$5, rows_updated=$6, rows_noop=$7,
             warnings_count=$8
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

    logger.info(report, "competitions ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
