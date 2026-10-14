// src/api/lib/client-ip.ts — IP du client derrière nginx.
//
// nginx pose X-Real-IP = $remote_addr (valeur NON falsifiable : il écrase celle du client) et
// X-Forwarded-For = $proxy_add_x_forwarded_for (il AJOUTE l'IP réelle À LA FIN de ce que le client
// a envoyé). La première entrée de X-Forwarded-For est donc contrôlée par le client : il suffisait
// d'en changer à chaque requête pour contourner le rate-limit. On lit X-Real-IP, sinon la DERNIÈRE
// entrée de X-Forwarded-For (celle ajoutée par notre proxy).
import type { Context } from "hono";

export function clientIp(c: Context): string | null {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const xff = c.req.header("x-forwarded-for");
  if (!xff) return null;
  const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last ?? null;
}
