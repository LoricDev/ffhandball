// src/webhooks/url-guard.ts — protection SSRF : un webhook ne doit viser que des hôtes publics en HTTPS.
// Sans cela, un abonné pourrait faire appeler par NOTRE serveur son réseau interne (localhost, 10.x,
// métadonnées cloud 169.254.169.254, base de données…).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultResolver: Resolver = (host) => lookup(host, { all: true });

/** true pour toute adresse non routable publiquement (v4 et v6). */
export function isPrivateIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateIp(mapped[1]!);

  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local (métadonnées cloud)
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || // 192.0.0.0/24 et 192.0.2.0/24 (documentation)
      (a === 198 && (b === 18 || b === 19)) || // tests de performance
      a >= 224 // multicast, réservé, broadcast
    );
  }

  if (isIP(ip) === 6) {
    const x = ip.toLowerCase();
    return (
      x === "::" ||
      x === "::1" ||
      x.startsWith("fc") ||
      x.startsWith("fd") || // unique local fc00::/7
      /^fe[89ab]/.test(x) || // link-local fe80::/10
      x.startsWith("ff") // multicast
    );
  }
  return true; // adresse non reconnue → par prudence
}

export class UnsafeUrlError extends Error {}

/** Valide l'URL (https, pas d'identifiants, hôte public) et renvoie l'URL normalisée. */
export async function assertPublicHttpsUrl(raw: string, resolve: Resolver = defaultResolver): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("URL invalide");
  }
  if (u.protocol !== "https:") throw new UnsafeUrlError("seul HTTPS est accepté");
  if (u.username || u.password) throw new UnsafeUrlError("identifiants dans l'URL interdits");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("hôte interne interdit");
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new UnsafeUrlError("adresse IP privée ou réservée interdite");
    return u.toString();
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new UnsafeUrlError("nom d'hôte introuvable (DNS)");
  }
  if (addrs.length === 0) throw new UnsafeUrlError("nom d'hôte introuvable (DNS)");
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new UnsafeUrlError("l'hôte résout vers une adresse privée ou réservée");
  }
  return u.toString();
}
