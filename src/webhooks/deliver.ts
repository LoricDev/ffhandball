// src/webhooks/deliver.ts — envoi des webhooks en attente (appelé chaque minute par cron).
import { randomUUID } from "node:crypto";
import { query } from "@/db/client.js";
import { logger } from "@/lib/logger.js";
import { signPayload } from "@/webhooks/signing.js";
import { assertPublicHttpsUrl, type Resolver } from "@/webhooks/url-guard.js";

/** Délai avant la reprise qui suit l'échec n° i+1. 7 tentatives au total. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 24 * 3600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Un abonné qui échoue autant de fois de suite est désactivé (pour ne pas marteler une URL morte). */
export const MAX_CONSECUTIVE_FAILURES = 30;
const TIMEOUT_MS = 10_000;

/** Délai avant la prochaine tentative, ou null si on abandonne. `attempts` = tentatives déjà faites. */
export function nextRetryDelayMs(attempts: number): number | null {
  return attempts >= MAX_ATTEMPTS ? null : RETRY_DELAYS_MS[attempts - 1]!;
}

interface DueRow {
  id: string;
  attempts: number;
  event_id: string;
  event: string;
  payload: unknown;
  event_created_at: Date;
  subscription_id: string;
  url: string;
  secret: string;
}

export interface DeliverOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  now?: () => Date;
}

export interface DeliverReport {
  due: number;
  delivered: number;
  retried: number;
  failed: number;
}

export async function deliverDue(opts: DeliverOptions = {}): Promise<DeliverReport> {
  const doFetch = opts.fetchImpl ?? fetch;
  const report: DeliverReport = { due: 0, delivered: 0, retried: 0, failed: 0 };

  // Réserve le lot (SKIP LOCKED : deux workers ne prennent jamais la même livraison) en repoussant
  // next_attempt_at : si le process meurt en cours de route, la livraison revient d'elle-même.
  const claimed = await query<DueRow>(
    `WITH due AS (
       SELECT d.id FROM core.webhook_deliveries d
         JOIN core.webhook_subscriptions s ON s.id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND s.active
        ORDER BY d.next_attempt_at
        LIMIT $1
        FOR UPDATE OF d SKIP LOCKED
     ), claimed AS (
       UPDATE core.webhook_deliveries d
          SET next_attempt_at = now() + interval '5 minutes'
         FROM due WHERE d.id = due.id
       RETURNING d.id, d.attempts, d.event_id, d.subscription_id
     )
     SELECT c.id, c.attempts, c.event_id, e.event, e.payload, e.created_at AS event_created_at,
            c.subscription_id, s.url, s.secret
       FROM claimed c
       JOIN core.match_events e ON e.id = c.event_id
       JOIN core.webhook_subscriptions s ON s.id = c.subscription_id`,
    [opts.limit ?? 100],
  );
  report.due = claimed.rows.length;

  for (const row of claimed.rows) {
    const attempts = row.attempts + 1;
    let httpStatus: number | null = null;
    let error: string | null = null;

    try {
      const url = await assertPublicHttpsUrl(row.url, opts.resolver);
      const body = JSON.stringify({
        id: row.event_id,
        type: row.event,
        created_at: row.event_created_at,
        data: row.payload,
      });
      const ts = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
      const res = await doFetch(url, {
        method: "POST",
        redirect: "manual", // on ne suit pas les redirections (contournement SSRF)
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "user-agent": "ffhandball-webhooks/1.0",
          "x-webhook-id": randomUUID(),
          "x-webhook-delivery": String(row.id),
          "x-webhook-timestamp": String(ts),
          "x-webhook-signature": signPayload(row.secret, ts, body),
        },
        body,
      });
      httpStatus = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (error === null) {
      await query(
        `UPDATE core.webhook_deliveries
            SET status = 'delivered', attempts = $2, last_status = $3, last_error = NULL, delivered_at = now()
          WHERE id = $1`,
        [row.id, attempts, httpStatus],
      );
      await query(`UPDATE core.webhook_subscriptions SET consecutive_failures = 0 WHERE id = $1`, [row.subscription_id]);
      report.delivered++;
      continue;
    }

    const delay = nextRetryDelayMs(attempts);
    if (delay === null) {
      await query(
        `UPDATE core.webhook_deliveries
            SET status = 'failed', attempts = $2, last_status = $3, last_error = $4
          WHERE id = $1`,
        [row.id, attempts, httpStatus, error.slice(0, 500)],
      );
      report.failed++;
    } else {
      await query(
        `UPDATE core.webhook_deliveries
            SET attempts = $2, last_status = $3, last_error = $4,
                next_attempt_at = now() + ($5::float * interval '1 millisecond')
          WHERE id = $1`,
        [row.id, attempts, httpStatus, error.slice(0, 500), delay],
      );
      report.retried++;
    }
    const sub = await query<{ consecutive_failures: number }>(
      `UPDATE core.webhook_subscriptions SET consecutive_failures = consecutive_failures + 1
        WHERE id = $1 RETURNING consecutive_failures`,
      [row.subscription_id],
    );
    if ((sub.rows[0]?.consecutive_failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
      await query(
        `UPDATE core.webhook_subscriptions
            SET active = false, disabled_reason = $2
          WHERE id = $1 AND active`,
        [
          row.subscription_id,
          `désactivé automatiquement après ${MAX_CONSECUTIVE_FAILURES} échecs consécutifs (dernier : ${error.slice(0, 120)})`,
        ],
      );
      logger.warn({ subscription_id: row.subscription_id }, "webhook désactivé (échecs consécutifs)");
    }
  }

  return report;
}
