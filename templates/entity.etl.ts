// templates/entity.etl.ts
// ─────────────────────────────────────────────────────────────────────────────
// MODÈLE d'ETL : lit raw.<entity> → valide → upsert dans core.<entity>.
// Copier vers : src/etl/<entity>.etl.ts
//
// Conventions respectées :
//  • ouvre un core.etl_runs au début, le clôture (success/failed) à la fin
//  • DISTINCT ON (natural_key) … ORDER BY scraped_at DESC → garde la capture la + récente
//  • valide chaque payload avec le schéma Zod ; échec → ligne dans core.etl_rejets
//  • upsert idempotent via ON CONFLICT ; RETURNING (xmax=0) distingue insert/update
//  • résolution de FK : si un parent est introuvable → core.etl_warnings (non bloquant)
// ─────────────────────────────────────────────────────────────────────────────
import { query } from "@/db/client.js";
import { rawEntityPayloadSchema, type RawEntityPayload } from "@/schemas/entity.schema.js";
import { logger } from "@/lib/logger.js";

interface RawEntityRow {
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

export async function runEntityEtl(saison: string): Promise<EtlReport> {
  // 1. Ouvrir le run.
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('entity', $1) RETURNING id`,
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
    // 2. Lire la dernière capture de chaque clé naturelle pour la saison.
    const rawRows = await query<RawEntityRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.entity
        WHERE saison = $1
        ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      // 3. Valider.
      const parsed = rawEntityPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'entity',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;
      const p: RawEntityPayload = parsed.data;

      // 4. (optionnel) Résoudre une FK vers un parent déjà chargé en core.
      //    Exemple : retrouver core.poules.id à partir d'un ext_poule_id.
      //
      // const parentRes = await query<{ id: number }>(
      //   `SELECT id FROM core.poules WHERE id_ffhb = $1 AND saison_code = $2`,
      //   [p.ext_poule_id, saison],
      // );
      // const parent_id = parentRes.rows[0]?.id ?? null;
      // if (parent_id === null) {
      //   await query(
      //     `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
      //      VALUES ($1,'entity',$2,$3)`,
      //     [etl_run_id, p.ext_entity_id, `parent ${p.ext_poule_id} introuvable`],
      //   );
      //   report.warnings_count++;
      //   continue; // ou insérer avec parent_id NULL si la colonne est nullable
      // }

      // 5. Upsert idempotent.
      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.entity (id_ffhb, nom, saison_code, last_seen_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (id_ffhb, saison_code) DO UPDATE
            SET nom = EXCLUDED.nom,
                last_seen_at = now(),
                updated_at = CASE
                  WHEN core.entity.nom IS DISTINCT FROM EXCLUDED.nom
                  THEN now() ELSE core.entity.updated_at
                END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [p.ext_entity_id, p.nom, saison],
      );

      const result = upsert.rows[0]!;
      if (result.inserted) report.rows_inserted++;
      else if (result.updated) report.rows_updated++;
      else report.rows_noop++;
    }

    // 6. Clôturer le run (success).
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

    logger.info(report, "entity ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
