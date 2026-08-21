import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createMetricImport,
  createStoredFile,
  deleteStoredFile,
  discardMetricImport,
  getBankOperator,
  getDeveloper,
  getMetricImport,
  getStoredFile,
  listDeveloperMetricImports,
  setOperatorLogo,
  withTenant,
} from '@bgs/db';
import { DEFAULT_METRIC_VERSION, listSheetNames } from '@bgs/metric';
import {
  MAX_LOGO_BYTES,
  MAX_WORKBOOK_BYTES,
  deleteStoredBytes,
  isImageType,
  readStoredBytes,
  safeDownloadName,
  saveFile,
  sniffType,
} from '../storage.js';

/** Read one multipart file, refusing anything past the limit. */
async function readUpload(
  request: FastifyRequest,
  limit: number,
): Promise<{ bytes: Uint8Array; filename: string } | { error: string }> {
  const file = await request.file({ limits: { fileSize: limit, files: 1 } });
  if (!file) return { error: 'No file was uploaded.' };

  const buffer = await file.toBuffer();

  // `truncated` means the stream hit the cap; the partial bytes are discarded
  // rather than stored as though they were a whole file.
  if (file.file.truncated) {
    return { error: `That file is larger than the ${Math.round(limit / (1024 * 1024))}MB limit.` };
  }

  return { bytes: new Uint8Array(buffer), filename: file.filename ?? 'upload' };
}

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Upload an operator's logo for its quote documents (§3.1).
   *
   * Held per operator rather than globally: a quote drawn from a client's stock
   * carries that client's logo, not Cosdon's.
   */
  app.post<{ Params: { id: string } }>(
    '/api/bank-operators/:id/logo',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const auth = request.auth!;

      const operator = await withTenant(auth.organisationId, (tx) => getBankOperator(tx, request.params.id));
      if (!operator) return reply.code(404).send({ error: 'Bank operator not found.' });

      const upload = await readUpload(request, MAX_LOGO_BYTES);
      if ('error' in upload) return reply.code(400).send({ error: upload.error });

      // What the file actually is, not what it claimed to be.
      const sniffed = sniffType(upload.bytes);
      if (!sniffed || !isImageType(sniffed.kind)) {
        return reply.code(400).send({
          error: 'That is not an image the platform recognises. Upload a PNG, JPEG, GIF or BMP.',
        });
      }

      const saved = await saveFile(operator.organisationId, upload.bytes, sniffed);

      const result = await withTenant(auth.organisationId, async (tx) => {
        const stored = await createStoredFile(tx, {
          organisationId: operator.organisationId,
          kind: 'branding-logo',
          originalFilename: upload.filename,
          contentType: saved.contentType,
          byteSize: saved.byteSize,
          sha256: saved.sha256,
          storagePath: saved.storagePath,
          uploadedBy: auth.userId,
        });

        const previousFileId = await setOperatorLogo(tx, operator.id, stored.id);
        return { stored, previousFileId };
      });

      // Replace rather than accumulate: the old logo's row and bytes both go.
      if (result.previousFileId && result.previousFileId !== result.stored.id) {
        const previous = await withTenant(auth.organisationId, (tx) =>
          deleteStoredFile(tx, result.previousFileId!),
        );
        if (previous) await deleteStoredBytes(previous.storagePath);
      }

      return reply.code(201).send({
        logo: {
          fileId: result.stored.id,
          filename: result.stored.originalFilename,
          contentType: result.stored.contentType,
          byteSize: result.stored.byteSize,
        },
      });
    },
  );

  /**
   * Serve an operator's logo back.
   *
   * Behind the session like everything else: a logo is not secret, but an
   * endpoint that serves stored files without a session is one an attacker can
   * enumerate, and the same code path will later serve things that are secret.
   */
  app.get<{ Params: { id: string } }>(
    '/api/bank-operators/:id/logo',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;

      const file = await withTenant(auth.organisationId, async (tx) => {
        const operator = await getBankOperator(tx, request.params.id);
        if (!operator?.branding.logoFileId) return null;
        return getStoredFile(tx, operator.branding.logoFileId);
      });

      if (!file) return reply.code(404).send({ error: 'No logo has been uploaded for this operator.' });

      const bytes = await readStoredBytes(file.storagePath);
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', `inline; filename="${safeDownloadName(file.originalFilename, 'logo')}"`)
        .send(Buffer.from(bytes));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/bank-operators/:id/logo',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const auth = request.auth!;

      const removed = await withTenant(auth.organisationId, async (tx) => {
        const operator = await getBankOperator(tx, request.params.id);
        if (!operator) return { missing: true as const };
        if (!operator.branding.logoFileId) return { file: null };

        await setOperatorLogo(tx, operator.id, null);
        return { file: await deleteStoredFile(tx, operator.branding.logoFileId) };
      });

      if ('missing' in removed) return reply.code(404).send({ error: 'Bank operator not found.' });
      if (removed.file) await deleteStoredBytes(removed.file.storagePath);
      return { ok: true };
    },
  );

  /**
   * Upload a developer's metric workbook (§4.2).
   *
   * The file is kept, not merely read. The off-site write-back works by
   * patching the developer's own workbook so its macros, validation and
   * existing figures survive, which means the original has to still be here
   * when the quote is finished.
   */
  app.post<{ Params: { id: string } }>(
    '/api/developers/:id/metric',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const auth = request.auth!;

      const developer = await withTenant(auth.organisationId, (tx) => getDeveloper(tx, request.params.id));
      if (!developer) return reply.code(404).send({ error: 'Developer not found.' });

      const upload = await readUpload(request, MAX_WORKBOOK_BYTES);
      if ('error' in upload) return reply.code(400).send({ error: upload.error });

      const sniffed = sniffType(upload.bytes);
      if (!sniffed || sniffed.kind !== 'xlsx') {
        return reply.code(400).send({
          error: 'That is not an Excel workbook. Upload the developer’s metric as .xlsx or .xlsm.',
        });
      }

      // Confirm it opens and has sheets before accepting it, so a corrupt file
      // is refused now rather than at export time weeks later.
      let sheetNames: string[];
      try {
        sheetNames = listSheetNames(upload.bytes);
      } catch {
        return reply.code(400).send({
          error: 'That workbook could not be opened. It may be corrupt, or password protected.',
        });
      }
      if (sheetNames.length === 0) {
        return reply.code(400).send({ error: 'That workbook has no worksheets in it.' });
      }

      const macroEnabled = upload.filename.toLowerCase().endsWith('.xlsm');
      const saved = await saveFile(developer.organisationId, upload.bytes, {
        kind: 'xlsx',
        contentType: macroEnabled
          ? 'application/vnd.ms-excel.sheet.macroEnabled.12'
          : sniffed.contentType,
      });

      const created = await withTenant(auth.organisationId, async (tx) => {
        const stored = await createStoredFile(tx, {
          organisationId: developer.organisationId,
          kind: 'developer-metric',
          originalFilename: upload.filename,
          contentType: saved.contentType,
          byteSize: saved.byteSize,
          sha256: saved.sha256,
          storagePath: saved.storagePath,
          uploadedBy: auth.userId,
        });

        return createMetricImport(tx, {
          organisationId: developer.organisationId,
          kind: 'developer',
          developerId: developer.id,
          fileId: stored.id,
          metricVersion: DEFAULT_METRIC_VERSION,
          importedBy: auth.userId,
        });
      });

      return reply.code(201).send({
        metricImport: {
          id: created.id,
          metricVersion: created.metricVersion,
          filename: upload.filename,
          byteSize: saved.byteSize,
          sheetCount: sheetNames.length,
          createdAt: created.createdAt,
        },
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/developers/:id/metrics',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const result = await withTenant(auth.organisationId, async (tx) => {
        const developer = await getDeveloper(tx, request.params.id);
        if (!developer) return null;
        return listDeveloperMetricImports(tx, developer.id);
      });

      if (!result) return reply.code(404).send({ error: 'Developer not found.' });
      return { metricImports: result };
    },
  );

  /** Download the workbook exactly as it was uploaded. */
  app.get<{ Params: { id: string } }>(
    '/api/metric-imports/:id/file',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;

      const file = await withTenant(auth.organisationId, async (tx) => {
        const record = await getMetricImport(tx, request.params.id);
        if (!record?.fileId) return null;
        return getStoredFile(tx, record.fileId);
      });

      if (!file) return reply.code(404).send({ error: 'Metric workbook not found.' });

      const bytes = await readStoredBytes(file.storagePath);
      return reply
        .header('content-type', file.contentType)
        .header(
          'content-disposition',
          `attachment; filename="${safeDownloadName(file.originalFilename, 'metric.xlsx')}"`,
        )
        .send(Buffer.from(bytes));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/metric-imports/:id',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const auth = request.auth!;
      const discarded = await withTenant(auth.organisationId, (tx) =>
        discardMetricImport(tx, request.params.id),
      );
      if (!discarded) return reply.code(404).send({ error: 'Metric workbook not found.' });
      // The row and its bytes are kept: an import that has already been quoted
      // against is part of the record, so it is marked discarded rather than
      // erased.
      return { ok: true };
    },
  );
}
