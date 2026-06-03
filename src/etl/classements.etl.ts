// src/etl/classements.etl.ts
import { query } from "@/db/client.js";
import { iterateRawBatched, countRawDistinct } from "@/etl/shared/iterate-raw-batched.js";
import { rawClassementPayloadSchema, type RawClassementPayload } from "@/schemas/classement.schema.js";
import { logger } from "@/lib/logger.js";
import { insertWarnings, type EtlWarning } from "@/etl/shared/etl-warnings.js";
import { loadIdIndex } from "@/etl/shared/lookups.js";
import { Progress } from "@/lib/progress.js";
import { EtlCheckpoint } from "@/etl/shared/checkpoint.js";

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
    // Préchargement des index FK en mémoire + warnings insérés en lot à la fin.
    const poules = await loadIdIndex("poules", saison);
    const equipes = await loadIdIndex("equipes", saison);
    const warnings: EtlWarning[] = [];
    const prog = new Progress("etl classements", await countRawDistinct("raw.classements", saison));
    const checkpoint = new EtlCheckpoint(etl_run_id);

    for await (const row of iterateRawBatched("raw.classements", saison)) {
      report.rows_read++;
      prog.tick(report.rows_read);
      await checkpoint.maybe(report.rows_read);
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

      const poule_id = poules.get(p.ext_poule_id) ?? null;
      if (poule_id === null) {
        warnings.push({ natural_key: p.ext_classement_id, message: `poule ${p.ext_poule_id} introuvable` });
        report.warnings_count++;
        continue;
      }

      const equipe_id = equipes.get(p.ext_equipe_id) ?? null;
      if (equipe_id === null) {
        warnings.push({ natural_key: p.ext_classement_id, message: `equipe ${p.ext_equipe_id} introuvable` });
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

    prog.done(report.rows_read);
    await insertWarnings(etl_run_id, "classements", warnings);

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
