import { query } from "@/db/client.js";

export async function resolveDepartementId(
  code: string | null | undefined,
): Promise<number | null> {
  if (!code) return null;
  const res = await query<{ id: number }>(
    `SELECT id FROM core.departements WHERE code = $1 LIMIT 1`,
    [code],
  );
  return res.rows[0]?.id ?? null;
}

export async function resolveLigueIdFromDept(
  dept_id: number | null,
): Promise<number | null> {
  if (dept_id === null) return null;
  const res = await query<{ ligue_id: number | null }>(
    `SELECT ligue_id FROM core.departements WHERE id = $1`,
    [dept_id],
  );
  return res.rows[0]?.ligue_id ?? null;
}
