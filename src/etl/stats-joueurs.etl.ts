// src/etl/stats-joueurs.etl.ts
import { query } from "@/db/client.js";
import { iterateRawBatched, countRawDistinct } from "@/etl/shared/iterate-raw-batched.js";
import { rawStatsJoueurPayloadSchema, type RawStatsJoueurPayload } from "@/schemas/stats-joueur.schema.js";
import { logger } from "@/lib/logger.js";
import { insertWarnings, type EtlWarning } from "@/etl/shared/etl-warnings.js";
import { loadIdIndex, loadEquipeNameIndex } from "@/etl/shared/lookups.js";
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
    // Préchargement des index FK (poule par id, équipe par nom) + warnings en lot.
    const poules = await loadIdIndex("poules", saison);
    const equipesById = await loadIdIndex("equipes", saison);
    const equipesByName = await loadEquipeNameIndex(saison);
    const warnings: EtlWarning[] = [];
    const prog = new Progress("etl stats-joueurs", await countRawDistinct("raw.stats_joueurs", saison));
    const checkpoint = new EtlCheckpoint(etl_run_id);

    for await (const row of iterateRawBatched("raw.stats_joueurs", saison)) {
      report.rows_read++;
      prog.tick(report.rows_read);
      await checkpoint.maybe(report.rows_read);
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
      const poule_id = poules.get(p.ext_poule_id) ?? null;
      if (poule_id === null) {
        warnings.push({ natural_key: row.natural_key, message: `poule ${p.ext_poule_id} introuvable` });
        report.warnings_count++;
        continue;
      }

      // FK equipe : par ID (fiable, via equipe_options de la poule) ; fallback par nom pour les
      // anciennes lignes raw scrapées sans ext_equipe_id. On insère même si non résolu (NULL).
      const equipe_id =
        (p.ext_equipe_id ? equipesById.get(p.ext_equipe_id) : undefined) ??
        equipesByName.get(p.equipe_libelle) ??
        null;
      if (equipe_id === null) {
        warnings.push({
          natural_key: row.natural_key,
          message: `équipe "${p.equipe_libelle}" (id=${p.ext_equipe_id ?? "?"}) non résolue`,
        });
        report.warnings_count++;
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

    prog.done(report.rows_read);
    await insertWarnings(etl_run_id, "stats_joueurs", warnings);

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
