import type { FastifyInstance } from 'fastify';
import { UnitQuantity } from '@bgs/core';
import {
  allocationRowFromParcel,
  checkParcelExportReadiness,
  writeOffSiteAllocation,
  type OffSiteAllocationRow,
  type ParcelForExport,
} from '@bgs/metric';
import {
  getMetricImport,
  getQuote,
  getStockParcel,
  getStoredFile,
  latestDeveloperMetricImport,
  withTenant,
} from '@bgs/db';
import { loadApiConfig } from '../env.js';
import { readStoredBytes, safeDownloadName } from '../storage.js';

/**
 * Write a finished allocation back into the developer's own metric workbook
 * (§4.7).
 *
 * The developer's uploaded file is patched, not replaced: their workbook keeps
 * its macros, its data validation and every figure already in it, and gains the
 * off-site creation rows for the units they are buying. The original upload is
 * never modified — a copy is generated on each download.
 */
export default async function metricExportRoutes(app: FastifyInstance): Promise<void> {
  const config = loadApiConfig();

  /** Everything needed to write a quote's allocation into a workbook. */
  async function gather(organisationId: string, quoteId: string) {
    return withTenant(organisationId, async (tx) => {
      const quote = await getQuote(tx, quoteId, config.staleQuoteDays);
      if (!quote) return { error: 'not-found' as const };

      const metricImport = quote.developerMetricId
        ? await getMetricImport(tx, quote.developerMetricId)
        : await latestDeveloperMetricImport(tx, quote.developerId);

      if (!metricImport?.fileId) return { error: 'no-workbook' as const, quote };

      const file = await getStoredFile(tx, metricImport.fileId);
      if (!file) return { error: 'no-workbook' as const, quote };

      // Parcels are read individually because each line needs the parcel's own
      // metric inputs — the workbook recomputes units from them.
      const parcels = new Map<string, Awaited<ReturnType<typeof getStockParcel>>>();
      for (const line of quote.lines) {
        if (!parcels.has(line.stockParcelId)) {
          parcels.set(line.stockParcelId, await getStockParcel(tx, line.stockParcelId));
        }
      }

      return { quote, metricImport, file, parcels };
    });
  }

  function toParcelForExport(
    parcel: NonNullable<Awaited<ReturnType<typeof getStockParcel>>>,
  ): ParcelForExport {
    return {
      reference: parcel.parcelReference,
      broadHabitat: parcel.broadHabitat,
      habitatType: parcel.habitatType,
      condition: parcel.condition,
      strategicSignificance: parcel.strategicSignificance,
      totalUnits: parcel.totalUnits,
      extent: parcel.extent,
      habitatCreatedInAdvanceYears: parcel.habitatCreatedInAdvanceYears,
      delayYears: parcel.delayYears,
    };
  }

  /** What the export would do, and anything standing in its way. */
  app.get<{ Params: { id: string } }>(
    '/api/quotes/:id/metric-export-preview',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const gathered = await gather(auth.organisationId, request.params.id);

      if ('error' in gathered && gathered.error === 'not-found') {
        return reply.code(404).send({ error: 'Quote not found.' });
      }

      const quote = gathered.quote!;
      const blockers: string[] = [];

      if ('error' in gathered && gathered.error === 'no-workbook') {
        blockers.push(
          'No metric workbook has been uploaded for this developer. Upload theirs on the developer record, and the allocation can be written into a copy of it.',
        );
      }
      if (quote.lines.length === 0) {
        blockers.push('This quote has no allocation lines, so there is nothing to write.');
      }

      // A parcel missing its metric inputs cannot be written, because the
      // developer's workbook recomputes units from exactly those figures.
      const parcels = 'parcels' in gathered ? gathered.parcels : new Map();
      for (const [, parcel] of parcels) {
        if (!parcel) continue;
        const readiness = checkParcelExportReadiness(toParcelForExport(parcel));
        if (!readiness.ready) {
          blockers.push(`Parcel ${parcel.parcelReference} is missing: ${readiness.missing.join(', ')}.`);
        }
      }

      const modules = [...new Set(quote.lines.map((line) => line.module))];

      return {
        ready: blockers.length === 0,
        blockers,
        quoteReference: quote.reference,
        workbook:
          'file' in gathered && gathered.file
            ? {
                filename: gathered.file.originalFilename,
                byteSize: gathered.file.byteSize,
                metricVersion: gathered.metricImport?.metricVersion ?? null,
              }
            : null,
        modules,
        lineCount: quote.lines.length,
      };
    },
  );

  /** Download the developer's workbook with the off-site tabs filled in. */
  app.get<{ Params: { id: string } }>(
    '/api/quotes/:id/metric-export',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const gathered = await gather(auth.organisationId, request.params.id);

      if ('error' in gathered && gathered.error === 'not-found') {
        return reply.code(404).send({ error: 'Quote not found.' });
      }
      if ('error' in gathered && gathered.error === 'no-workbook') {
        return reply.code(409).send({
          error:
            'No metric workbook has been uploaded for this developer. Upload theirs on the developer record first.',
        });
      }

      const { quote, metricImport, file, parcels } = gathered as Exclude<typeof gathered, { error: unknown }>;

      if (quote.lines.length === 0) {
        return reply.code(409).send({ error: 'This quote has no allocation lines, so there is nothing to write.' });
      }

      // Grouped by module: the three write to three separate sheets and are
      // never combined.
      const allocation: Partial<Record<'area' | 'hedgerow' | 'watercourse', OffSiteAllocationRow[]>> = {};

      for (const line of quote.lines) {
        const parcel = parcels.get(line.stockParcelId);
        if (!parcel) {
          return reply.code(409).send({ error: 'A parcel on this quote could no longer be read.' });
        }

        try {
          const row = allocationRowFromParcel(
            toParcelForExport(parcel),
            {
              allocatedUnits: UnitQuantity.of(line.module, line.rawQuantity),
              spatialBand: line.spatialBand,
              userComments: `${quote.reference} — supplied by ${quote.bankOperatorName ?? 'habitat bank'}`,
            },
            metricImport.metricVersion,
          );
          (allocation[line.module] ??= []).push(row);
        } catch (error) {
          // A parcel missing an input the workbook needs is a stop, not a
          // silent omission: writing it without would give the developer a
          // different unit figure from the one they were quoted.
          return reply.code(409).send({ error: (error as Error).message });
        }
      }

      const original = await readStoredBytes(file.storagePath);

      let result;
      try {
        result = writeOffSiteAllocation(original, allocation, { metricVersion: metricImport.metricVersion });
      } catch (error) {
        return reply.code(409).send({
          error: `The allocation could not be written into that workbook: ${(error as Error).message}`,
        });
      }

      const base = file.originalFilename.replace(/\.(xlsx|xlsm)$/i, '');
      const extension = file.originalFilename.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx';
      const filename = safeDownloadName(`${base} - ${quote.reference} off-site.${extension}`, 'metric.xlsx');

      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', `attachment; filename="${filename}"`)
        // Anything the writer wants to flag travels in a header rather than the
        // body, since the body is the workbook itself.
        .header('x-bgs-warnings', String(result.warnings.length))
        .send(Buffer.from(result.file));
    },
  );
}
