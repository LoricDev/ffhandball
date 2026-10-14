// src/webhooks/signing.ts — signature HMAC des webhooks.
//
// En-têtes envoyés :  X-Webhook-Timestamp: <secondes epoch>
//                     X-Webhook-Signature: sha256=<hex>   avec  hex = HMAC_SHA256(secret, `${timestamp}.${corps}`)
// Le destinataire recalcule la signature sur le CORPS BRUT et rejette les horodatages trop anciens
// (anti-rejeu, par ex. > 5 min). Voir docs/webhooks.md.
import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret: string, timestamp: number, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(secret: string, timestamp: number, body: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
