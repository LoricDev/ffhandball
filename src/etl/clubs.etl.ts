import { query } from "@/db/client.js";
import { rawClubPayloadSchema, type RawClubPayload } from "@/schemas/club.schema.js";
import { titleCaseFr } from "@/etl/shared/normalize-text.js";
import { resolveDepartementId, resolveLigueIdFromDept } from "@/etl/shared/resolve-fk.js";
import { logger } from "@/lib/logger.js";

interface RawClubRow {
  id: number;
  natural_key: string;
  payload: unknown;
}

interface EtlReport {
  etl_run_id: number;
  rows_read: number;
  rows_validated: number;
  rows_rejected: number;
  rows_inserted: number;
  rows_updated: number;
  rows_noop: number;
  warnings_count: number;
}

function computeEffectif(p: RawClubPayload): number | null {
  const parts = [
    p.nb_licence_senior_h,
    p.nb_licence_senior_f,
    p.nb_licence_jeunes_h,
    p.nb_licence_jeunes_f,
  ].filter((n): n is number => typeof n === "number");
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0);
}

export async function runClubsEtl(saison: string): Promise<EtlReport> {
  const runRes = await query<{ id: number }>(
    `INSERT INTO core.etl_runs (entity, saison) VALUES ('clubs', $1) RETURNING id`,
    [saison],
  );
  const etl_run_id = runRes.rows[0]!.id;

  const report = {
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
    const rawRows = await query<RawClubRow>(
      `SELECT DISTINCT ON (natural_key) id, natural_key, payload
         FROM raw.clubs
         WHERE saison = $1
         ORDER BY natural_key, scraped_at DESC`,
      [saison],
    );
    report.rows_read = rawRows.rowCount ?? 0;

    for (const row of rawRows.rows) {
      const parsed = rawClubPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        await query(
          `INSERT INTO core.etl_rejets
             (etl_run_id, entity, raw_row_id, natural_key, payload, reason)
           VALUES ($1,'clubs',$2,$3,$4,$5)`,
          [etl_run_id, row.id, row.natural_key, row.payload, parsed.error.message],
        );
        report.rows_rejected++;
        continue;
      }
      report.rows_validated++;

      const p: RawClubPayload = parsed.data;
      const nom = titleCaseFr(p.nom);
      const ville = p.ville ? titleCaseFr(p.ville) : null;
      const dept_id = await resolveDepartementId(p.departement_code);
      if (p.departement_code && dept_id === null) {
        await query(
          `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
           VALUES ($1, 'clubs', $2, $3)`,
          [etl_run_id, p.id_ffhb, `dept ${p.departement_code} introuvable`],
        );
        report.warnings_count++;
      }
      const ligue_id = await resolveLigueIdFromDept(dept_id);

      let salle_principale_id: number | null = null;
      if (p.salle_principale_id_ffhb) {
        const sRes = await query<{ id: number }>(
          `SELECT id FROM core.salles WHERE id_ffhb = $1 LIMIT 1`,
          [p.salle_principale_id_ffhb],
        );
        salle_principale_id = sRes.rows[0]?.id ?? null;
        if (salle_principale_id === null) {
          await query(
            `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message)
             VALUES ($1, 'clubs', $2, $3)`,
            [
              etl_run_id,
              p.id_ffhb,
              `salle ${p.salle_principale_id_ffhb} introuvable, FK non résolue`,
            ],
          );
          report.warnings_count++;
        }
      }

      const upsert = await query<{ inserted: boolean; updated: boolean }>(
        `INSERT INTO core.clubs (
           id_ffhb, nom, ville, departement_id, ligue_id, salle_principale_id,
           slug, telephone, email, site_web, adresse_correspondance,
           latitude, longitude, register_link, logo_club,
           nb_licence_senior_h, nb_licence_senior_f, nb_licence_jeunes_h, nb_licence_jeunes_f,
           effectif_estime,
           last_seen_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
         ON CONFLICT (id_ffhb) DO UPDATE
         SET nom = EXCLUDED.nom,
             ville = EXCLUDED.ville,
             departement_id = EXCLUDED.departement_id,
             ligue_id = EXCLUDED.ligue_id,
             salle_principale_id = COALESCE(EXCLUDED.salle_principale_id, core.clubs.salle_principale_id),
             slug = COALESCE(EXCLUDED.slug, core.clubs.slug),
             telephone = COALESCE(EXCLUDED.telephone, core.clubs.telephone),
             email = COALESCE(EXCLUDED.email, core.clubs.email),
             site_web = COALESCE(EXCLUDED.site_web, core.clubs.site_web),
             adresse_correspondance = COALESCE(EXCLUDED.adresse_correspondance, core.clubs.adresse_correspondance),
             latitude = COALESCE(EXCLUDED.latitude, core.clubs.latitude),
             longitude = COALESCE(EXCLUDED.longitude, core.clubs.longitude),
             register_link = COALESCE(EXCLUDED.register_link, core.clubs.register_link),
             logo_club = COALESCE(EXCLUDED.logo_club, core.clubs.logo_club),
             nb_licence_senior_h = COALESCE(EXCLUDED.nb_licence_senior_h, core.clubs.nb_licence_senior_h),
             nb_licence_senior_f = COALESCE(EXCLUDED.nb_licence_senior_f, core.clubs.nb_licence_senior_f),
             nb_licence_jeunes_h = COALESCE(EXCLUDED.nb_licence_jeunes_h, core.clubs.nb_licence_jeunes_h),
             nb_licence_jeunes_f = COALESCE(EXCLUDED.nb_licence_jeunes_f, core.clubs.nb_licence_jeunes_f),
             effectif_estime = COALESCE(EXCLUDED.effectif_estime, core.clubs.effectif_estime),
             last_seen_at = now(),
             updated_at = CASE
               WHEN core.clubs.nom IS DISTINCT FROM EXCLUDED.nom
                 OR core.clubs.ville IS DISTINCT FROM EXCLUDED.ville
                 OR core.clubs.departement_id IS DISTINCT FROM EXCLUDED.departement_id
                 OR core.clubs.ligue_id IS DISTINCT FROM EXCLUDED.ligue_id
                 OR (EXCLUDED.salle_principale_id IS NOT NULL
                     AND core.clubs.salle_principale_id IS DISTINCT FROM EXCLUDED.salle_principale_id)
                 OR (EXCLUDED.slug IS NOT NULL
                     AND core.clubs.slug IS DISTINCT FROM EXCLUDED.slug)
                 OR (EXCLUDED.telephone IS NOT NULL
                     AND core.clubs.telephone IS DISTINCT FROM EXCLUDED.telephone)
                 OR (EXCLUDED.email IS NOT NULL
                     AND core.clubs.email IS DISTINCT FROM EXCLUDED.email)
                 OR (EXCLUDED.site_web IS NOT NULL
                     AND core.clubs.site_web IS DISTINCT FROM EXCLUDED.site_web)
                 OR (EXCLUDED.adresse_correspondance IS NOT NULL
                     AND core.clubs.adresse_correspondance IS DISTINCT FROM EXCLUDED.adresse_correspondance)
                 OR (EXCLUDED.latitude IS NOT NULL
                     AND core.clubs.latitude IS DISTINCT FROM EXCLUDED.latitude)
                 OR (EXCLUDED.longitude IS NOT NULL
                     AND core.clubs.longitude IS DISTINCT FROM EXCLUDED.longitude)
                 OR (EXCLUDED.register_link IS NOT NULL
                     AND core.clubs.register_link IS DISTINCT FROM EXCLUDED.register_link)
                 OR (EXCLUDED.logo_club IS NOT NULL
                     AND core.clubs.logo_club IS DISTINCT FROM EXCLUDED.logo_club)
                 OR (EXCLUDED.nb_licence_senior_h IS NOT NULL
                     AND core.clubs.nb_licence_senior_h IS DISTINCT FROM EXCLUDED.nb_licence_senior_h)
                 OR (EXCLUDED.nb_licence_senior_f IS NOT NULL
                     AND core.clubs.nb_licence_senior_f IS DISTINCT FROM EXCLUDED.nb_licence_senior_f)
                 OR (EXCLUDED.nb_licence_jeunes_h IS NOT NULL
                     AND core.clubs.nb_licence_jeunes_h IS DISTINCT FROM EXCLUDED.nb_licence_jeunes_h)
                 OR (EXCLUDED.nb_licence_jeunes_f IS NOT NULL
                     AND core.clubs.nb_licence_jeunes_f IS DISTINCT FROM EXCLUDED.nb_licence_jeunes_f)
                 OR (EXCLUDED.effectif_estime IS NOT NULL
                     AND core.clubs.effectif_estime IS DISTINCT FROM EXCLUDED.effectif_estime)
               THEN now()
               ELSE core.clubs.updated_at
             END
         RETURNING (xmax = 0) AS inserted,
                   (xmax <> 0 AND updated_at = now()) AS updated`,
        [
          p.id_ffhb,
          nom,
          ville,
          dept_id,
          ligue_id,
          salle_principale_id,
          p.slug ?? null,
          p.telephone ?? null,
          p.email ?? null,
          p.site_web ?? null,
          p.adresse_correspondance ?? null,
          p.latitude ?? null,
          p.longitude ?? null,
          p.register_link ?? null,
          p.logo_club ?? null,
          p.nb_licence_senior_h ?? null,
          p.nb_licence_senior_f ?? null,
          p.nb_licence_jeunes_h ?? null,
          p.nb_licence_jeunes_f ?? null,
          computeEffectif(p),
        ],
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

    logger.info(report, "clubs ETL done");
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
