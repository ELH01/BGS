import { spawn } from 'node:child_process';
import type { Queryable } from './client.js';

/**
 * Backup and restore (§4.8).
 *
 * The specification was written for a single local SQLite file, where backup
 * meant copying it. With third-party operators signing in to see their own
 * stock, that one action has become two quite different ones, and running them
 * together would hand every tenant's commercial data to whoever pressed the
 * button.
 *
 *   - **An organisation export** is a tenant's own data, safe for any of its
 *     users to take. It goes through the same row-level security as every
 *     other query, so it can only ever contain what that organisation may see.
 *
 *   - **A database backup** is the whole instance, for disaster recovery. It
 *     is the operator of the instance's concern, and is restricted to them.
 *
 * Restore is deliberately not exposed over HTTP. An endpoint that replaces the
 * entire database is a dangerous thing to have reachable from a browser
 * session, and "a clear confirmation step" is served far better by a
 * deliberate command run on the machine that holds the data. The UI points at
 * the command rather than hiding it.
 */

/**
 * Tables that carry tenant data, in dependency order.
 *
 * Listed explicitly rather than discovered from the catalogue: a new table
 * should have to be considered and added, not silently included in — or
 * silently missing from — everyone's export.
 */
const TENANT_TABLES = [
  'bank_operator',
  'habitat_bank_site',
  'stored_file',
  'metric_import',
  'stock_parcel',
  'developer',
  'developer_metric',
  'developer_metric_module',
  'developer_metric_requirement',
  'quote',
  'quote_module_target',
  'allocation_line',
  'sale_record',
  'sale_retirement',
  'audit_log',
] as const;

export interface OrganisationExport {
  format: 'bgs-organisation-export';
  version: 1;
  exportedAt: string;
  organisation: { id: string; name: string; slug: string };
  /** Row counts per table, so a restore can be checked at a glance. */
  counts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

/**
 * Export one organisation's data as JSON.
 *
 * Numeric columns arrive as strings and are written as strings (see client.ts),
 * so a 4dp unit quantity survives the round trip exactly. Serialising them as
 * JSON numbers would put every stored decimal through a double on the way out,
 * which is the one thing this system will not do.
 */
export async function exportOrganisation(db: Queryable, organisationId: string): Promise<OrganisationExport> {
  const { rows: orgRows } = await db.query<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM organisation WHERE id = $1',
    [organisationId],
  );
  const organisation = orgRows[0];
  if (!organisation) {
    throw new Error('Organisation not found, or not visible to the signed-in user.');
  }

  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of TENANT_TABLES) {
    // Row-level security still applies, so this can only return rows the
    // acting organisation may see.
    const { rows } = await db.query(`SELECT * FROM ${table} WHERE organisation_id = $1`, [organisationId]);
    tables[table] = rows;
    counts[table] = rows.length;
  }

  return {
    format: 'bgs-organisation-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    organisation,
    counts,
    tables,
  };
}

export function organisationExportFilename(slug: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${slug}-export-${stamp}.json`;
}

export function databaseBackupFilename(at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `bgs-backup-${stamp}.dump`;
}

export interface BackupResult {
  data: Buffer;
  filename: string;
}

/**
 * A whole-database backup, in Postgres's own custom format.
 *
 * Custom format rather than plain SQL because it restores with `pg_restore`,
 * which can rebuild into an existing cluster and reports clearly on what it
 * did. The file is compressed, so it is also considerably smaller.
 */
export async function backupDatabase(connectionString: string): Promise<BackupResult> {
  const chunks: Buffer[] = [];
  const errors: string[] = [];

  await new Promise<void>((resolve, reject) => {
    // --no-owner and --no-privileges so the dump restores into a cluster whose
    // role names differ from this one's, which they usually will.
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', connectionString], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString()));

    child.on('error', (error) => {
      reject(
        new Error(
          `Could not run pg_dump: ${error.message}. It comes with the Postgres client tools; install those on whatever runs the API.`,
        ),
      );
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited with code ${code}. ${errors.join('').trim()}`));
    });
  });

  return { data: Buffer.concat(chunks), filename: databaseBackupFilename() };
}

/**
 * Restore a whole-database backup, replacing everything currently stored.
 *
 * Destructive and irreversible: anything created since the backup was taken is
 * gone. Callable only from the command line, and the CLI requires the phrase
 * to be typed out before it will run.
 */
export async function restoreDatabase(connectionString: string, dumpPath: string): Promise<string> {
  const output: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pg_restore',
      ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', connectionString, dumpPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

    child.on('error', (error) => {
      reject(new Error(`Could not run pg_restore: ${error.message}.`));
    });

    child.on('close', (code) => {
      // pg_restore exits non-zero for warnings as well as failures, so the
      // output is returned either way for the operator to read.
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited with code ${code}.\n${output.join('')}`));
    });
  });

  return output.join('');
}

/** Whether the Postgres client tools are available to this process. */
export async function backupToolsAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('pg_dump', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
