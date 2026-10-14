// src/api/lib/repositories/traffic.repo.ts — statistiques de trafic de l'API (onglet « Trafic » de l'admin).
import { query } from "@/db/client.js";

export const TRAFFIC_WINDOWS = [24, 72, 168] as const;

/** Les routes admin ne comptent pas : rafraîchir le dashboard fausserait les chiffres. */
const NOT_ADMIN = `l.path NOT LIKE '/admin%'`;

export async function getTraffic(hours: number) {
  const win = (TRAFFIC_WINDOWS as readonly number[]).includes(hours) ? hours : 24;

  const [series, totals, routes, keys, ips] = await Promise.all([
    query(
      `WITH h AS (
         SELECT generate_series(date_trunc('hour', now()) - ($1::int - 1) * interval '1 hour',
                                date_trunc('hour', now()), interval '1 hour') AS t)
       SELECT h.t,
              count(l.id)::int AS total,
              count(l.id) FILTER (WHERE l.status >= 400 AND l.status < 500)::int AS err_4xx,
              count(l.id) FILTER (WHERE l.status >= 500)::int AS err_5xx
         FROM h
         LEFT JOIN core.api_logs l
           ON l.requested_at >= h.t AND l.requested_at < h.t + interval '1 hour' AND ${NOT_ADMIN}
        GROUP BY h.t ORDER BY h.t`,
      [win],
    ),
    query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status < 400)::int AS ok,
              count(*) FILTER (WHERE status >= 400 AND status < 500 AND status <> 429)::int AS err_4xx,
              count(*) FILTER (WHERE status = 429)::int AS rate_limited,
              count(*) FILTER (WHERE status >= 500)::int AS err_5xx,
              count(*) FILTER (WHERE key_prefix IS NOT NULL)::int AS with_key,
              count(DISTINCT ip)::int AS distinct_ips,
              COALESCE(round(avg(duration_ms)), 0)::int AS avg_ms,
              COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms
         FROM core.api_logs l
        WHERE l.requested_at > now() - ($1::int * interval '1 hour') AND ${NOT_ADMIN}`,
      [win],
    ),
    // Les identifiants (numériques ou codes) sont regroupés : /clubs/1720/matchs → /clubs/:id/matchs.
    query(
      `SELECT regexp_replace(l.path, '/[^/]*[0-9][^/]*', '/:id', 'g') AS route,
              count(*)::int AS hits,
              COALESCE(round(avg(l.duration_ms)), 0)::int AS avg_ms,
              COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY l.duration_ms), 0)::int AS p95_ms,
              count(*) FILTER (WHERE l.status >= 500)::int AS err_5xx
         FROM core.api_logs l
        WHERE l.requested_at > now() - ($1::int * interval '1 hour') AND ${NOT_ADMIN}
        GROUP BY 1 ORDER BY hits DESC LIMIT 15`,
      [win],
    ),
    query(
      `SELECT l.key_prefix, k.label, count(*)::int AS hits,
              count(*) FILTER (WHERE l.status = 429)::int AS rate_limited,
              count(*) FILTER (WHERE l.status >= 500)::int AS err_5xx
         FROM core.api_logs l LEFT JOIN core.api_keys k ON k.key_prefix = l.key_prefix
        WHERE l.requested_at > now() - ($1::int * interval '1 hour') AND l.key_prefix IS NOT NULL AND ${NOT_ADMIN}
        GROUP BY l.key_prefix, k.label ORDER BY hits DESC LIMIT 15`,
      [win],
    ),
    query(
      `SELECT l.ip, count(*)::int AS hits, count(*) FILTER (WHERE l.status = 429)::int AS rate_limited
         FROM core.api_logs l
        WHERE l.requested_at > now() - ($1::int * interval '1 hour') AND l.key_prefix IS NULL
          AND l.ip IS NOT NULL AND ${NOT_ADMIN}
        GROUP BY l.ip ORDER BY hits DESC LIMIT 10`,
      [win],
    ),
  ]);

  return {
    hours: win,
    totals: totals.rows[0],
    series: series.rows,
    top_routes: routes.rows,
    top_keys: keys.rows,
    top_anonymous_ips: ips.rows,
  };
}
