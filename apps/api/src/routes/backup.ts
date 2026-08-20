import type { FastifyInstance } from 'fastify';
import {
  backupDatabase,
  backupToolsAvailable,
  exportOrganisation,
  loadDbConfig,
  organisationExportFilename,
  withTenant,
} from '@bgs/db';

/**
 * Backup routes (§4.8).
 *
 * Two different things, deliberately kept apart — see the note in
 * packages/db/src/backup.ts. Restore is not here at all: replacing the whole
 * database is not something that should be reachable from a browser session.
 */
export default async function backupRoutes(app: FastifyInstance): Promise<void> {
  /** What is available, and how to restore. Drives the backup screen. */
  app.get('/api/backup/status', { onRequest: [app.requireAuth] }, async (request) => {
    const auth = request.auth!;
    const toolsAvailable = await backupToolsAvailable();
    const canBackupDatabase = auth.isPlatformOperator && (auth.role === 'owner' || auth.role === 'admin');

    return {
      organisationExport: {
        available: true,
        description:
          'Everything recorded for your organisation — operators, sites, stock, developers, quotes, sales and the audit log — as a single JSON file.',
      },
      databaseBackup: {
        available: canBackupDatabase && toolsAvailable,
        allowed: canBackupDatabase,
        toolsAvailable,
        description: canBackupDatabase
          ? 'A complete copy of the whole instance, for disaster recovery. Contains every organisation’s data.'
          : 'Whole-instance backups are taken by whoever runs this platform.',
        ...(canBackupDatabase && !toolsAvailable
          ? {
              problem:
                'pg_dump is not available to the API process. It ships with the Postgres client tools; install those on whatever runs the API.',
            }
          : {}),
      },
      restore: {
        // Not offered over HTTP on purpose.
        viaHttp: false,
        instructions:
          'Restoring replaces everything currently stored and cannot be undone, so it is done from the command line on the machine holding the data: pnpm db:restore <backup-file>. It will ask you to type a confirmation phrase before it does anything.',
      },
    };
  });

  /**
   * This organisation's own data.
   *
   * Runs through the same row-level security as every other query, so it can
   * only ever contain what the acting organisation may see.
   */
  app.get('/api/backup/organisation', { onRequest: [app.requireAuth] }, async (request, reply) => {
    const auth = request.auth!;

    const data = await withTenant(auth.organisationId, (tx) => exportOrganisation(tx, auth.organisationId));
    const filename = organisationExportFilename(auth.organisationSlug);

    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(JSON.stringify(data, null, 2));
  });

  /**
   * The whole instance.
   *
   * Restricted to an owner or admin of the organisation running the platform:
   * this file contains every tenant's stock levels and negotiated pricing, so
   * it must not be reachable by a client operator who happens to have an
   * account.
   */
  app.get('/api/backup/database', { onRequest: [app.requireAuth] }, async (request, reply) => {
    const auth = request.auth!;

    if (!auth.isPlatformOperator || (auth.role !== 'owner' && auth.role !== 'admin')) {
      return reply.code(403).send({
        error: 'Whole-instance backups are taken by whoever runs this platform, not by individual operators.',
      });
    }

    try {
      const { data, filename } = await backupDatabase(loadDbConfig().migrationUrl);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(data);
    } catch (error) {
      return reply.code(503).send({ error: (error as Error).message });
    }
  });
}
