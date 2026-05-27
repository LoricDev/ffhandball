// src/etl/arbitres.etl.ts
import { query } from "@/db/client.js";
import { splitNomComplet } from "@/etl/shared/split-nom-complet.js";
import { logger } from "@/lib/logger.js";

interface ArbitreUnique {
  id_ffhb: string;
  nom_complet: string;
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

export async function runArbitresEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('arbitres', $1) RETURNING id`,
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
    const arbitresRes = await query<ArbitreUnique>(
      `SELECT DISTINCT id_ffhb, nom_complet FROM (
         SELECT payload->>'arbitre1_id'  AS id_ffhb,
                payload->>'arbitre1_nom' AS nom_complet
           FROM raw.matchs
          WHERE saison = $1
            AND payload->>'arbitre1_id'  IS NOT NULL
            AND payload->>'arbitre1_nom' IS NOT NULL
         UNION
         SELECT payload->>'arbitre2_id'  AS id_ffhb,
                payload->>'arbitre2_nom' AS nom_complet
           FROM raw.matchs
          WHERE saison = $1
            AND payload->>'arbitre2_id'  IS NOT NULL
            AND payload->>'arbitre2_nom' IS NOT NULL
       ) AS u
       WHERE id_ffhb <> '' AND nom_complet <> ''`,
      [saison],
    );
    report.rows_read = arbitresRes.rowCount ?? 0;

    for (const row of arbitresRes.rows) {
      let nom: string;
      let prenom: string | null;
      try {
        const split = splitNomComplet(row.nom_complet);
        nom = split.nom;
        prenom = split.prenom;
      } catch (err) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'arbitres',NULL,$2,$3,$4)`,
          [etl_run_id, row.id_ffhb, JSON.stringify(row), String((err as Error).message)],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.arbitres (id_ffhb, nom, prenom, nom_complet, last_seen_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom         = EXCLUDED.nom,
             prenom      = COALESCE(EXCLUDED.prenom, core.arbitres.prenom),
             nom_complet = EXCLUDED.nom_complet,
             last_seen_at = now(),
             updated_at  = CASE
               WHEN core.arbitres.nom IS DISTINCT FROM EXCLUDED.nom
                 OR (EXCLUDED.prenom IS NOT NULL AND core.arbitres.prenom IS DISTINCT FROM EXCLUDED.prenom)
                 OR core.arbitres.nom_complet IS DISTINCT FROM EXCLUDED.nom_complet
               THEN now()
               ELSE core.arbitres.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [row.id_ffhb, nom, prenom, row.nom_complet],
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

    logger.info(report, "arbitres ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
