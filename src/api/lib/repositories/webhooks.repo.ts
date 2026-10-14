// src/api/lib/repositories/webhooks.repo.ts — abonnements webhook (administration).
import { randomBytes } from "node:crypto";
import { query } from "@/db/client.js";

export interface WebhookSubscription {
  id: string;
  label: string | null;
  url: string;
  club_id_ffhb: string | null;
  active: boolean;
  disabled_reason: string | null;
  consecutive_failures: number;
  created_at: Date;
}

const PUBLIC_COLS = `id, label, url, club_id_ffhb, active, disabled_reason, consecutive_failures, created_at`;

/** Crée un abonnement. Le secret n'est renvoyé QU'ICI : il n'est ensuite plus jamais affiché. */
export async function createWebhook(input: {
  url: string;
  label?: string;
  club_id_ffhb?: string;
}): Promise<WebhookSubscription & { secret: string }> {
  const secret = "whsec_" + randomBytes(24).toString("hex");
  const r = await query<WebhookSubscription>(
    `INSERT INTO core.webhook_subscriptions (url, label, club_id_ffhb, secret)
     VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_COLS}`,
    [input.url, input.label ?? null, input.club_id_ffhb ?? null, secret],
  );
  return { ...r.rows[0]!, secret };
}

export async function listWebhooks(): Promise<Array<WebhookSubscription & { pending: number; failed: number; delivered: number }>> {
  const r = await query<WebhookSubscription & { pending: string; failed: string; delivered: string }>(
    `SELECT s.id, s.label, s.url, s.club_id_ffhb, s.active, s.disabled_reason, s.consecutive_failures, s.created_at,
            count(*) FILTER (WHERE d.status = 'pending')   AS pending,
            count(*) FILTER (WHERE d.status = 'failed')    AS failed,
            count(*) FILTER (WHERE d.status = 'delivered') AS delivered
       FROM core.webhook_subscriptions s
       LEFT JOIN core.webhook_deliveries d ON d.subscription_id = s.id
      GROUP BY s.id ORDER BY s.id`,
  );
  return r.rows.map((x) => ({ ...x, pending: Number(x.pending), failed: Number(x.failed), delivered: Number(x.delivered) }));
}

export async function setWebhookActive(id: string, active: boolean): Promise<boolean> {
  const r = await query(
    `UPDATE core.webhook_subscriptions
        SET active = $2, disabled_reason = CASE WHEN $2 THEN NULL ELSE 'désactivé manuellement' END,
            consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures END
      WHERE id = $1`,
    [id, active],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const r = await query(`DELETE FROM core.webhook_subscriptions WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function listDeliveries(id: string, limit = 50) {
  const r = await query(
    `SELECT d.id, e.event, d.status, d.attempts, d.last_status, d.last_error, d.next_attempt_at, d.delivered_at, d.created_at
       FROM core.webhook_deliveries d JOIN core.match_events e ON e.id = d.event_id
      WHERE d.subscription_id = $1 ORDER BY d.id DESC LIMIT $2`,
    [id, limit],
  );
  return r.rows;
}

/** Événement « ping » de test : livré à cet abonné au prochain passage du worker (≤ 1 min). */
export async function enqueuePing(id: string): Promise<boolean> {
  const sub = await query(`SELECT 1 FROM core.webhook_subscriptions WHERE id = $1`, [id]);
  if (sub.rowCount === 0) return false;
  const ev = await query<{ id: string }>(
    `INSERT INTO core.match_events (match_id, event, payload)
     VALUES (NULL, 'ping', jsonb_build_object('message', 'Test de webhook ffhandball', 'sent_at', now()))
     RETURNING id`,
  );
  await query(`INSERT INTO core.webhook_deliveries (subscription_id, event_id) VALUES ($1, $2)`, [id, ev.rows[0]!.id]);
  return true;
}
