import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "@/webhooks/signing.js";
import { assertPublicHttpsUrl, isPrivateIp, UnsafeUrlError } from "@/webhooks/url-guard.js";
import { nextRetryDelayMs, MAX_ATTEMPTS } from "@/webhooks/deliver.js";

describe("signature HMAC", () => {
  const secret = "whsec_test";
  const body = '{"a":1}';

  it("est déterministe et vérifiable", () => {
    const sig = signPayload(secret, 1760000000, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload(secret, 1760000000, body)).toBe(sig);
    expect(verifySignature(secret, 1760000000, body, sig)).toBe(true);
  });

  it("change si le corps, l'horodatage ou le secret change", () => {
    const sig = signPayload(secret, 1760000000, body);
    expect(verifySignature(secret, 1760000000, body + " ", sig)).toBe(false);
    expect(verifySignature(secret, 1760000001, body, sig)).toBe(false);
    expect(verifySignature("autre", 1760000000, body, sig)).toBe(false);
    expect(verifySignature(secret, 1760000000, body, "sha256=court")).toBe(false);
  });
});

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ])("%s est privée ou réservée", (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"])(
    "%s est publique",
    (ip) => expect(isPrivateIp(ip)).toBe(false),
  );
});

describe("assertPublicHttpsUrl", () => {
  const publicDns = async () => [{ address: "93.184.216.34" }];
  const privateDns = async () => [{ address: "10.0.0.5" }];

  it("accepte une URL HTTPS publique", async () => {
    await expect(assertPublicHttpsUrl("https://example.org/hook", publicDns)).resolves.toBe("https://example.org/hook");
  });

  it.each([
    "http://example.org/hook",
    "https://user:pass@example.org/hook",
    "https://localhost/hook",
    "https://app.localhost/hook",
    "https://serveur.internal/hook",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://169.254.169.254/latest/meta-data",
    "ftp://example.org",
    "pas une url",
  ])("refuse %s", async (u) => {
    await expect(assertPublicHttpsUrl(u, publicDns)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("refuse un nom d'hôte qui résout vers une IP privée (DNS rebinding)", async () => {
    await expect(assertPublicHttpsUrl("https://evil.example/hook", privateDns)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("refuse un hôte introuvable", async () => {
    const dnsFail = async (): Promise<Array<{ address: string }>> => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicHttpsUrl("https://nope.example/hook", dnsFail)).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("nextRetryDelayMs", () => {
  it("progression 1 min → 24 h puis abandon à la 7e tentative", () => {
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(5 * 60_000);
    expect(nextRetryDelayMs(6)).toBe(24 * 3600_000);
    expect(nextRetryDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(7);
  });
});
