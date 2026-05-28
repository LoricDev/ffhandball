// src/etl/stats-joueurs.etl.ts
import { query } from "@/db/client.js";
import { rawStatsJoueurPayloadSchema, type RawStatsJoueurPayload } from "@/schemas/stats-joueur.schema.js";
import { logger } from "@/lib/logger.js";

interface RawStatsRow {
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

async function resolveEquipeIdByLibelle(libelle: string, saison: string): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM core.equipes WHERE nom = $1 AND saison_code = $2 LIMIT 1`,
    [libelle, saison],
  );
  return r.rows[0]?.id ?? null;
}

export async function runStatsJoueursEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('stats_joueurs', $1) RETURNING id`,
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
    const rawRows = await query<RawStatsRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.stats_joueurs
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawStatsJoueurPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'stats_joueurs',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawStatsJoueurPayload = parsed.data;

      // FK poule strict
      const poule_id = await resolvePouleId(p.ext_poule_id, saison);
      if (poule_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'stats_joueurs',$2,$3)`,
          [etl_run_id, row.natural_key, `poule ${p.ext_poule_id} introuvable`],
        );
        report.warnings_count++;
        continue;
      }

      // FK equipe best-effort (match exact sur nom saison-scopé)
      const equipe_id = await resolveEquipeIdByLibelle(p.equipe_libelle, saison);
      if (equipe_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1,'stats_joueurs',$2,$3)`,
          [etl_run_id, row.natural_key, `équipe "${p.equipe_libelle}" non résolue`],
        );
        report.warnings_count++;
        // continue : on insère quand même avec equipe_id = NULL
      }

      const upsert = await query<{ inserted: boolean }>(
        `INSERT INTO core.stats_joueurs (
           poule_id, individu_id, nom, prenom, equipe_id, equipe_libelle,
           match_count, total_buts, total_arrets, saison_code, capture_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (poule_id, individu_id) DO UPDATE
         SET nom            = EXCLUDED.nom,
             prenom         = EXCLUDED.prenom,
             equipe_id      = COALESCE(EXCLUDED.equipe_id, core.stats_joueurs.equipe_id),
             equipe_libelle = EXCLUDED.equipe_libelle,
             match_count    = EXCLUDED.match_count,
             total_buts     = EXCLUDED.total_buts,
             total_arrets   = EXCLUDED.total_arrets,
             capture_date   = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          poule_id, p.individu_id, p.nom, p.prenom,
          equipe_id, p.equipe_libelle,
          p.match_count, p.total_buts, p.total_arrets,
          saison,
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

    logger.info(report, "stats_joueurs ETL done");
    return report;
  } catch (err) {
    await query(
      `UPDATE core.etl_runs SET finished_at = now(), status='failed', error_message=$2 WHERE id=$1`,
      [etl_run_id, String(err instanceof Error ? err.message : err)],
    );
    throw err;
  }
}
