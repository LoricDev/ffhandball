import { query } from "@/db/client.js";
import { rawSallePayloadSchema, type RawSallePayload } from "@/schemas/salle.schema.js";
import { normalizeText, titleCaseFr } from "@/etl/shared/normalize-text.js";
import { resolveDepartementId } from "@/etl/shared/resolve-fk.js";
import { logger } from "@/lib/logger.js";

interface RawSalleRow {
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

export async function runSallesEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('salles', $1) RETURNING id`,
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
    const rawRows = await query<RawSalleRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.salles
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawSallePayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets
             (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'salles',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawSallePayload = parsed.data;
      const nom = titleCaseFr(p.nom);
      const ville = p.ville ? titleCaseFr(p.ville) : null;
      const adresse = p.adresse ? normalizeText(p.adresse) : null;
      const cp = p.code_postal ?? null;
      const cap = p.capacite ?? null;

      const dept_id = await resolveDepartementId(p.departement_code);
      if (p.departement_code && dept_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1, 'salles', $2, $3)`,
          [etl_run_id, p.id_ffhb, `dept ${p.departement_code} introuvable`],
        );
        report.warnings_count++;
      }

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.salles (id_ffhb, nom, adresse, code_postal, ville, departement_id, capacite, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom = EXCLUDED.nom,
             adresse = EXCLUDED.adresse,
             code_postal = EXCLUDED.code_postal,
             ville = EXCLUDED.ville,
             departement_id = EXCLUDED.departement_id,
             capacite = EXCLUDED.capacite,
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.salles.nom IS DISTINCT FROM EXCLUDED.nom
                 OR core.salles.adresse IS DISTINCT FROM EXCLUDED.adresse
                 OR core.salles.code_postal IS DISTINCT FROM EXCLUDED.code_postal
                 OR core.salles.ville IS DISTINCT FROM EXCLUDED.ville
                 OR core.salles.departement_id IS DISTINCT FROM EXCLUDED.departement_id
                 OR core.salles.capacite IS DISTINCT FROM EXCLUDED.capacite
               THEN now()
               ELSE core.salles.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.id_ffhb, nom, adresse, cp, ville, dept_id, cap],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
    }

    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(),
             status = 'success',
             rows_read = $2,
             rows_validated = $3,
             rows_rejected = $4,
             rows_inserted = $5,
             rows_updated = $6,
             rows_noop = $7,
             warnings_count = $8
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

    logger.info(report, "salles ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs
         SET finished_at = now(), status = 'failed', error_message = $2
         WHERE id = $1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
