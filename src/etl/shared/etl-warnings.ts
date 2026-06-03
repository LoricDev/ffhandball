// src/etl/shared/etl-warnings.ts — insertion GROUPÉE des warnings ETL.
// Insérer un warning par ligne (un aller-retour DB chacun) coûte très cher quand des dizaines
// de milliers de lignes échouent (ex. matchs : ~95k). On accumule en mémoire et on insère par
// lots. Chunk borné pour rester sous la limite de 65535 paramètres par requête Postgres.
import { query } from "@/db/client.js";

export interface EtlWarning {
  natural_key: string | null;
  message: string;
}

const CHUNK = 1000; // 1000 lignes × 2 params + 2 = 2002 params, bien sous 65535

export async function insertWarnings(
  etlRunId: number,
  entity: string,
  warnings: EtlWarning[],
): Promise<void> {
  for (let i = 0; i < warnings.length; i += CHUNK) {
    const chunk = warnings.slice(i, i + CHUNK);
    const values = chunk
      .map((_, j) => `($1, $2, $${j * 2 + 3}, $${j * 2 + 4})`)
      .join(",");
    const params: unknown[] = [etlRunId, entity];
    for (const w of chunk) params.push(w.natural_key, w.message);
    await query(
      `INSERT INTO core.etl_warnings (etl_run_id, entity, natural_key, message) VALUES ${values}`,
      params,
    );
  }
}
