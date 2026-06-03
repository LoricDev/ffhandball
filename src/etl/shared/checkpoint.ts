// src/etl/shared/checkpoint.ts — persiste rows_read périodiquement dans core.etl_runs pendant
// un ETL, pour que `pnpm status` (depuis un autre terminal) voie l'avancement d'un run en cours.
// La ligne etl_runs est créée avec status='running' au début ; on rafraîchit juste rows_read.
import { query } from "@/db/client.js";

export class EtlCheckpoint {
  private last = Date.now();

  constructor(
    private readonly etlRunId: number,
    private readonly intervalMs = 3000,
  ) {}

  /** Met à jour rows_read en base si l'intervalle est écoulé (throttle). À appeler dans la boucle. */
  async maybe(rowsRead: number): Promise<void> {
    const t = Date.now();
    if (t - this.last < this.intervalMs) return;
    this.last = t;
    await query(`UPDATE core.etl_runs SET rows_read = $2 WHERE id = $1`, [this.etlRunId, rowsRead]);
  }
}
