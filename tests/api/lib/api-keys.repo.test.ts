// tests/api/lib/api-keys.repo.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { query, closePool } from "@/db/client.js";
import {
  generateToken,
  hashToken,
  createApiKey,
  findActiveKeyByToken,
  renewApiKey,
  revokeApiKey,
} from "@/api/lib/repositories/api-keys.repo.js";

async function cleanup(): Promise<void> {
  await query(`DELETE FROM core.api_keys WHERE label LIKE 'TEST-KEY-%'`);
}

beforeEach(cleanup);

describe("generateToken / hashToken", () => {
  it("génère un token ffhb_<40 hex> + préfixe + hash sha256 déterministe", () => {
    const { token, key_hash, key_prefix } = generateToken();
    expect(token).toMatch(/^ffhb_[0-9a-f]{40}$/);
    expect(key_prefix).toMatch(/^ffhb_[0-9a-f]{8}$/);
    expect(key_hash).toBe(hashToken(token));
    expect(key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createApiKey / findActiveKeyByToken", () => {
  it("crée une clé valide et la retrouve par token", async () => {
    const created = await createApiKey({ label: "TEST-KEY-1", months: 1 });
    expect(created.token).toMatch(/^ffhb_/);
    expect(created.valid_until).not.toBeNull();
    const found = await findActiveKeyByToken(created.token);
    expect(found).not.toBeNull();
    expect(found!.key_prefix).toBe(created.key_prefix);
  });

  it("ne retrouve pas un token inexistant", async () => {
    expect(await findActiveKeyByToken("ffhb_deadbeef")).toBeNull();
  });

  it("rejette une clé expirée (valid_until passé)", async () => {
    const created = await createApiKey({ label: "TEST-KEY-EXP", months: 1 });
    await query(`UPDATE core.api_keys SET valid_until = now() - interval '1 day' WHERE key_prefix = $1`, [created.key_prefix]);
    expect(await findActiveKeyByToken(created.token)).toBeNull();
  });

  it("rejette une clé révoquée (active=false)", async () => {
    const created = await createApiKey({ label: "TEST-KEY-REV", months: 1 });
    await revokeApiKey(created.key_prefix);
    expect(await findActiveKeyByToken(created.token)).toBeNull();
  });

  it("noExpiry → valid_until NULL, toujours valide", async () => {
    const created = await createApiKey({ label: "TEST-KEY-NOEXP", noExpiry: true });
    expect(created.valid_until).toBeNull();
    expect(await findActiveKeyByToken(created.token)).not.toBeNull();
  });
});

describe("renewApiKey", () => {
  it("avance valid_until et réactive l'accès", async () => {
    const created = await createApiKey({ label: "TEST-KEY-RENEW", months: 1 });
    await query(`UPDATE core.api_keys SET valid_until = now() - interval '1 day' WHERE key_prefix = $1`, [created.key_prefix]);
    expect(await findActiveKeyByToken(created.token)).toBeNull(); // expirée
    const res = await renewApiKey(created.key_prefix, 1);
    expect(res).not.toBeNull();
    expect(await findActiveKeyByToken(created.token)).not.toBeNull(); // de nouveau valide
  });
  it("renew d'un préfixe inconnu → null", async () => {
    expect(await renewApiKey("ffhb_00000000", 1)).toBeNull();
  });

  afterAll(async () => {
    await cleanup();
    await closePool();
  });
});
