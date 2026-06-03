// src/db/migrate.ts — runner de migrations SQL (lib réutilisable par la CLI `migrate` et `doctor`).
//
// Applique les fichiers db/migrations/*.sql dans l'ordre, en ne rejouant QUE ceux absents de
// public.schema_migrations (suivi des migrations appliquées + checksum pour détecter une dérive).
// Chaque migration tourne dans SA transaction (atomique) ; les fichiers sont du SQL pur (pas de
// méta-commande psql), donc exécutables tels quels via node-postgres.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { pool, query } from "@/db/client.js";

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  filename: string;
  applied: boolean;
  appliedAt: Date | null;
  drift: boolean; // appliquée mais le contenu du fichier a changé depuis
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

export function readMigrationFiles(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 0001_… < 0002_… : l'ordre lexicographique = l'ordre d'application
  return files.map((filename) => {
    const sql = readFileSync(MIGRATIONS_DIR + filename, "utf8");
    return { filename, sql, checksum: checksum(sql) };
  });
}

export async function ensureMigrationsTable(): Promise<void> {
  // public : toujours présent, sans dépendre des schémas raw/core créés par les migrations.
  await query(
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
       filename   text PRIMARY KEY,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function appliedMap(): Promise<Map<string, { checksum: string; applied_at: Date }>> {
  await ensureMigrationsTable();
  const r = await query<{ filename: string; checksum: string; applied_at: Date }>(
    `SELECT filename, checksum, applied_at FROM public.schema_migrations`,
  );
  return new Map(r.rows.map((x) => [x.filename, { checksum: x.checksum, applied_at: x.applied_at }]));
}

export async function migrationStatuses(): Promise<MigrationStatus[]> {
  const files = readMigrationFiles();
  const applied = await appliedMap();
  return files.map((f) => {
    const a = applied.get(f.filename);
    return {
      filename: f.filename,
      applied: Boolean(a),
      appliedAt: a?.applied_at ?? null,
      drift: Boolean(a && a.checksum !== f.checksum),
    };
  });
}

export async function pendingMigrations(): Promise<MigrationFile[]> {
  const applied = await appliedMap();
  return readMigrationFiles().filter((f) => !applied.has(f.filename));
}

// Applique une migration dans sa propre transaction et enregistre son passage (atomique).
export async function applyMigration(f: MigrationFile): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(f.sql);
    await client.query(
      `INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
      [f.filename, f.checksum],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Adoption d'une base DÉJÀ migrée (héritée du `db:migrate` aveugle) : marque tous les fichiers
// présents comme appliqués SANS les exécuter. Renvoie le nombre de lignes nouvellement marquées.
export async function baseline(): Promise<number> {
  await ensureMigrationsTable();
  let n = 0;
  for (const f of readMigrationFiles()) {
    const r = await query(
      `INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO NOTHING`,
      [f.filename, f.checksum],
    );
    if (r.rowCount) n += r.rowCount;
  }
  return n;
}
