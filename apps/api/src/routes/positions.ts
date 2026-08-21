import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Money } from '@bgs/core';
import {
  buildPositionWorkbook,
  positionExportFilename,
  quoteTotals,
  type PositionStatus,
} from '@bgs/documents';
import {
  getAllocationPositions,
  getBankOperator,
  getParcelPositions,
  getQuotePositions,
  withTenant,
} from '@bgs/db';
import { loadApiConfig } from '../env.js';

const STATUSES = ['draft', 'quoted', 'reserved', 'sold', 'cancelled'] as const;

const querySchema = z.object({
  bankOperatorId: z.string().uuid().optional(),
  /** Comma-separated; omitted means everything except cancelled. */
  statuses: z.string().optional(),
});


export default async function positionRoutes(app: FastifyInstance): Promise<void> {
  const config = loadApiConfig();

  /**
   * The commercial position as a spreadsheet: what is quoted, what is
   * reserved, what has sold, and what is left.
   *
   * A download rather than a screen because the questions people ask of this
   * data — sort by expiry, total a column, send it to an accountant — are the
   * ones a spreadsheet already answers.
   */
  app.get<{ Querystring: { bankOperatorId?: string; statuses?: string } }>(
    '/api/positions/export',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Unrecognised export filters.' });
      }

      const statuses = parsed.data.statuses
        ?.split(',')
        .map((value) => value.trim())
        .filter((value): value is PositionStatus => (STATUSES as readonly string[]).includes(value));

      if (parsed.data.statuses && (!statuses || statuses.length === 0)) {
        return reply.code(400).send({ error: `Statuses must be from: ${STATUSES.join(', ')}.` });
      }

      const auth = request.auth!;
      const filters = {
        ...(parsed.data.bankOperatorId ? { bankOperatorId: parsed.data.bankOperatorId } : {}),
        ...(statuses && statuses.length > 0 ? { statuses } : {}),
      };

      const data = await withTenant(auth.organisationId, async (tx) => {
        const [allocations, quotes, parcels, operator] = await Promise.all([
          getAllocationPositions(tx, filters),
          getQuotePositions(tx, filters),
          getParcelPositions(tx, filters),
          parsed.data.bankOperatorId ? getBankOperator(tx, parsed.data.bankOperatorId) : Promise.resolve(null),
        ]);
        return { allocations, quotes, parcels, operator };
      });

      // Filtering to a bank that is not visible would otherwise produce an
      // empty workbook that looks like a real answer.
      if (parsed.data.bankOperatorId && !data.operator) {
        return reply.code(404).send({ error: 'Bank operator not found.' });
      }

      const generatedAt = new Date();

      const workbook = await buildPositionWorkbook({
        organisationName: auth.organisationName,
        generatedAt,
        scope: {
          ...(data.operator ? { bankOperator: data.operator.name } : {}),
          ...(statuses && statuses.length > 0 ? { statuses } : {}),
        },
        allocations: data.allocations,
        quotes: data.quotes.map((quote) => {
          // VAT per quote, from the operator that quote supplies — the same
          // source the quote document reads, so the two agree. An operator that
          // is not registered contributes no VAT rather than a default rate.
          const totals = quoteTotals([Money.of(quote.totalExcludingVat)], {
            treatment: quote.vatRegistered ? 'standard-rate' : 'none',
            ratePercent: quote.vatRatePercent ?? '0',
            status: 'confirmed',
          });
          return {
            ...quote,
            isStale:
              (quote.status === 'quoted' || quote.status === 'reserved') &&
              Date.now() - quote.lastActivityAt.getTime() > config.staleQuoteDays * 86_400_000,
            totalExcludingVat: totals.net.toString(),
            vat: totals.vat.toString(),
            totalIncludingVat: totals.gross.toString(),
          };
        }),
        parcels: data.parcels,
      });

      const filename = positionExportFilename(generatedAt, data.operator?.name);

      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(Buffer.from(workbook));
    },
  );

  /** What the export would contain, for showing before downloading it. */
  app.get<{ Querystring: { bankOperatorId?: string; statuses?: string } }>(
    '/api/positions/summary',
    { onRequest: [app.requireAuth] },
    async (request) => {
      const auth = request.auth!;
      const bankOperatorId = request.query.bankOperatorId;

      const counts = await withTenant(auth.organisationId, async (tx) => {
        const filters = bankOperatorId ? { bankOperatorId } : {};
        const [allocations, quotes, parcels] = await Promise.all([
          getAllocationPositions(tx, filters),
          getQuotePositions(tx, filters),
          getParcelPositions(tx, filters),
        ]);
        return {
          allocationLines: allocations.length,
          quotes: quotes.length,
          parcels: parcels.length,
          overExposedParcels: parcels.filter((parcel) => parcel.isOverExposed).length,
        };
      });

      return { ...counts, defaultStatuses: ['draft', 'quoted', 'reserved', 'sold'] };
    },
  );
}
