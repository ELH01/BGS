import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  METRIC_MODULES,
  Money,
  SpatialRiskLookup,
  UnitQuantity,
  bufferedTarget,
  meetsTarget,
  type MetricModule,
} from '@bgs/core';
import {
  createDraftQuote,
  getQuote,
  getStockUnitPool,
  getSaleForQuote,
  listAudit,
  listQuotes,
  recordSale,
  replaceAllocationLines,
  reverseSale,
  updateQuoteDetails,
  updateQuoteStatus,
  updateSaleRegisterDate,
  withTenant,
  writeAudit,
  type AllocationLineInput,
  type QuoteModuleTarget,
} from '@bgs/db';
import { loadApiConfig } from '../env.js';
import { parseBody } from '../http.js';

const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Enter a plain decimal number.');

const moneyString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount in pounds and pence.');

const spatialBand = z.enum(['same-lpa', 'neighbouring-lpa-same-nca', 'outside']);

const createSchema = z.object({
  developerId: z.string().uuid(),
  developerMetricId: z.string().uuid().nullish(),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  notes: z.string().trim().max(5000).nullish(),
  /** Units required per module, from a metric import or entered by hand (§4.4). */
  targets: z
    .array(
      z.object({
        module: z.enum(METRIC_MODULES),
        source: z.enum(['metric', 'manual']),
        requiredUnits: decimalString,
      }),
    )
    .min(1),
});

const allocationSchema = z.object({
  lines: z.array(
    z.object({
      stockParcelId: z.string().uuid(),
      module: z.enum(METRIC_MODULES),
      rawQuantity: decimalString,
      spatialBand,
      unitPrice: moneyString,
      tradingRuleJustification: z.string().trim().max(2000).nullish(),
    }),
  ),
});

export default async function quoteRoutes(app: FastifyInstance): Promise<void> {
  const config = loadApiConfig();
  const lookup = new SpatialRiskLookup();

  /**
   * The status a quote may move to, and what has to be true first.
   * The database enforces the ladder itself; these checks exist to give a
   * useful message rather than a constraint violation.
   */
  const transitionSchema = z.object({
    status: z.enum(['quoted', 'reserved', 'sold', 'cancelled', 'draft']),
    reason: z.string().trim().max(2000).nullish(),
    reservationExpiresAt: z.string().datetime().nullish(),
    planningApplicationReference: z.string().trim().max(200).nullish(),
    soldDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  });

  app.get<{ Querystring: { status?: string; developerId?: string } }>(
    '/api/quotes',
    { onRequest: [app.requireAuth] },
    async (request) => {
      const auth = request.auth!;
      const quotes = await withTenant(auth.organisationId, (tx) =>
        listQuotes(tx, {
          ...(request.query.status ? { status: request.query.status as never } : {}),
          ...(request.query.developerId ? { developerId: request.query.developerId } : {}),
          staleAfterDays: config.staleQuoteDays,
        }),
      );
      return { quotes, staleAfterDays: config.staleQuoteDays };
    },
  );

  app.get<{ Params: { id: string } }>('/api/quotes/:id', { onRequest: [app.requireAuth] }, async (request, reply) => {
    const auth = request.auth!;
    const result = await withTenant(auth.organisationId, async (tx) => {
      const quote = await getQuote(tx, request.params.id, config.staleQuoteDays);
      if (!quote) return null;
      const [sale, audit] = await Promise.all([
        getSaleForQuote(tx, quote.id),
        listAudit(tx, 'quote', quote.id),
      ]);
      return { quote, sale, audit };
    });

    if (!result) return reply.code(404).send({ error: 'Quote not found.' });
    return result;
  });

  app.post('/api/quotes', { onRequest: [app.requireWriteAccess] }, async (request, reply) => {
    const body = parseBody(createSchema, request.body, reply);
    if (!body) return;
    const auth = request.auth!;

    const targets: QuoteModuleTarget[] = body.targets.map((target) => {
      const required = UnitQuantity.parse(target.module, target.requiredUnits);
      return {
        module: target.module,
        source: target.source,
        requiredUnits: required,
        // The figure the allocation must clear: the shortfall lifted just above
        // the statutory line so re-rounding cannot take it under (§4.3.4).
        bufferedTargetUnits: bufferedTarget(target.module, required, {
          gainPercent: '100',
          bufferPercent: config.netGainBufferPercent,
        }),
      };
    });

    const quoteId = await withTenant(auth.organisationId, (tx) =>
      createDraftQuote(tx, {
        organisationId: auth.organisationId,
        developerId: body.developerId,
        developerMetricId: body.developerMetricId ?? null,
        priority: body.priority,
        notes: body.notes ?? null,
        spatialSchemeId: lookup.scheme.id,
        bufferPercent: config.netGainBufferPercent,
        targets,
        createdBy: auth.userId,
      }),
    );

    const quote = await withTenant(auth.organisationId, (tx) =>
      getQuote(tx, quoteId, config.staleQuoteDays),
    );
    return reply.code(201).send({ quote });
  });

  /**
   * Save the allocation table (§4.4).
   *
   * Saving is always allowed, including below target — the specification is
   * explicit that a table can be parked mid-edit while waiting on stock. It is
   * moving to `quoted` that is gated.
   */
  app.put<{ Params: { id: string } }>(
    '/api/quotes/:id/allocation',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(allocationSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const result = await withTenant(auth.organisationId, async (tx) => {
        const quote = await getQuote(tx, request.params.id, config.staleQuoteDays);
        if (!quote) return { error: 'not-found' as const };
        if (quote.status === 'sold') {
          return { error: 'sold' as const };
        }
        if (quote.status === 'cancelled') {
          return { error: 'cancelled' as const };
        }

        const lines: AllocationLineInput[] = body.lines.map((line) => {
          const rawQuantity = UnitQuantity.parse(line.module, line.rawQuantity);
          return {
            stockParcelId: line.stockParcelId,
            module: line.module,
            rawQuantity,
            spatialBand: line.spatialBand,
            spatialFactor: lookup.deliveryFactor(line.spatialBand).toString(),
            // Rounded down by the lookup, so a line never claims to deliver
            // more than its multiplier actually yields.
            effectiveUnits: lookup.effectiveUnits(rawQuantity, line.spatialBand),
            unitPrice: Money.parse(line.unitPrice),
            tradingRuleJustification: line.tradingRuleJustification ?? null,
          };
        });

        const previousLines = quote.lines.map((line) => ({
          stockParcelId: line.stockParcelId,
          rawQuantity: line.rawQuantity.toString(),
          unitPrice: line.unitPrice.toString(),
        }));

        const total = await replaceAllocationLines(tx, quote.id, auth.organisationId, lines);

        // A quoted table is freely editable with no audit friction; a reserved
        // one is a firmer commitment, so every change is recorded (§4.4).
        if (quote.status === 'reserved') {
          await writeAudit(tx, {
            organisationId: auth.organisationId,
            entityType: 'quote',
            entityId: quote.id,
            action: 'allocation-edited-while-reserved',
            actorUserId: auth.userId,
            detail: {
              before: previousLines,
              after: lines.map((line) => ({
                stockParcelId: line.stockParcelId,
                rawQuantity: line.rawQuantity.toString(),
                unitPrice: line.unitPrice.toString(),
              })),
            },
          });
        }

        const updated = await getQuote(tx, quote.id, config.staleQuoteDays);
        return { quote: updated, total };
      });

      if ('error' in result) {
        if (result.error === 'not-found') return reply.code(404).send({ error: 'Quote not found.' });
        if (result.error === 'sold') {
          return reply.code(409).send({
            error: 'This quote has been sold. Reverse the sale before changing its allocation.',
          });
        }
        return reply.code(409).send({ error: 'This quote has been cancelled and cannot be edited.' });
      }

      if (!result.quote) return reply.code(404).send({ error: 'Quote not found.' });
      return { quote: result.quote, targetStatus: summariseTargets(result.quote) };
    },
  );

  /** How each module stands against its buffered target, for the live running total. */
  function summariseTargets(quote: NonNullable<Awaited<ReturnType<typeof getQuote>>>) {
    return quote.targets.map((target) => {
      const rows = quote.lines.filter((line) => line.module === target.module);
      const outcome = meetsTarget(target.bufferedTargetUnits, rows);
      return {
        module: target.module,
        requiredUnits: target.requiredUnits.toString(),
        bufferedTargetUnits: target.bufferedTargetUnits.toString(),
        deliveredUnits: outcome.delivered.toString(),
        shortBy: outcome.shortBy.toString(),
        meetsTarget: outcome.meets,
      };
    });
  }

  app.post<{ Params: { id: string } }>(
    '/api/quotes/:id/status',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(transitionSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const outcome = await withTenant(auth.organisationId, async (tx) => {
        const quote = await getQuote(tx, request.params.id, config.staleQuoteDays);
        if (!quote) return { error: 'Quote not found.', status: 404 };

        const from = quote.status;

        if (body.status === 'quoted' && from === 'draft') {
          // The hard gate (§4.4): every module must clear its buffered target.
          // Not optional — staying above 10% is the regulatory purpose of the
          // whole export.
          const short = summariseTargets(quote).filter((target) => !target.meetsTarget);
          if (short.length > 0) {
            return {
              error:
                'This quote cannot be issued yet: ' +
                short
                  .map((t) => `${t.module} is ${t.shortBy} units below its target of ${t.bufferedTargetUnits}`)
                  .join('; ') +
                '. The allocation table can still be saved as a draft in the meantime.',
              status: 409,
            };
          }
        }

        if (body.status === 'reserved' && from !== 'sold') {
          // A reservation is firm, so unlike a quote it must fit inside what is
          // actually available.
          const pool = await getStockUnitPool(tx);
          const byParcel = new Map(pool.map((entry) => [entry.stockParcelId, entry]));
          const over: string[] = [];

          for (const line of quote.lines) {
            const entry = byParcel.get(line.stockParcelId);
            if (!entry) continue;
            // This quote's own reservation does not yet count against the pool.
            if (line.rawQuantity.greaterThan(entry.availableUnits)) {
              over.push(
                `${entry.parcelReference} has ${entry.availableUnits} available but ${line.rawQuantity} is allocated`,
              );
            }
          }

          if (over.length > 0) {
            return {
              error: `A reservation holds stock firmly, so it cannot exceed what is available: ${over.join('; ')}.`,
              status: 409,
            };
          }
        }

        if (body.status === 'cancelled' && !body.reason) {
          return { error: 'Give a reason when cancelling a quote, so the history explains itself.', status: 400 };
        }

        if (body.status === 'sold') {
          if (!body.soldDate) {
            return { error: 'A sale needs the date it completed.', status: 400 };
          }
          if (quote.lines.length === 0) {
            return { error: 'This quote has no allocation, so there is nothing to sell.', status: 409 };
          }
        }

        const now = new Date();
        try {
          if (body.status === 'sold') {
            await updateQuoteStatus(tx, quote.id, 'sold', { soldAt: now });
            await recordSale(tx, {
              organisationId: auth.organisationId,
              quoteId: quote.id,
              planningApplicationReference: body.planningApplicationReference ?? null,
              soldDate: body.soldDate!,
            });
          } else if (body.status === 'reserved') {
            await updateQuoteStatus(tx, quote.id, 'reserved', {
              reservedAt: now,
              reservationExpiresAt: body.reservationExpiresAt ? new Date(body.reservationExpiresAt) : null,
            });
          } else if (body.status === 'cancelled') {
            await updateQuoteStatus(tx, quote.id, 'cancelled', {
              cancelledAt: now,
              cancellationReason: body.reason ?? null,
            });
          } else {
            await updateQuoteStatus(tx, quote.id, body.status);
          }
        } catch (error) {
          // The status ladder is enforced by a database trigger; its message is
          // already written for a person to read.
          const message = (error as { message?: string }).message ?? 'That status change is not allowed.';
          return { error: message.replace(/^.*?ERROR:\s*/, ''), status: 409 };
        }

        await writeAudit(tx, {
          organisationId: auth.organisationId,
          entityType: 'quote',
          entityId: quote.id,
          action: 'status-changed',
          fromStatus: from,
          toStatus: body.status,
          note: body.reason ?? null,
          actorUserId: auth.userId,
          detail: {
            ...(body.planningApplicationReference
              ? { planningApplicationReference: body.planningApplicationReference }
              : {}),
            ...(body.soldDate ? { soldDate: body.soldDate } : {}),
          },
        });

        return { quote: await getQuote(tx, quote.id, config.staleQuoteDays) };
      });

      if ('error' in outcome) {
        return reply.code(outcome.status ?? 409).send({ error: outcome.error });
      }
      return outcome;
    },
  );

  /**
   * Reverse a sale (§4.6.6).
   *
   * A deliberate action rather than a free edit: it restores the exact
   * quantities that were retired, moves the quote back, and demands a reason.
   */
  const reversalSchema = z.object({
    reason: z.string().trim().min(1, 'A reversal has to say why.').max(2000),
    moveTo: z.enum(['reserved', 'cancelled']),
  });

  app.post<{ Params: { id: string } }>(
    '/api/quotes/:id/reverse-sale',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(reversalSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const outcome = await withTenant(auth.organisationId, async (tx) => {
        const quote = await getQuote(tx, request.params.id, config.staleQuoteDays);
        if (!quote) return { error: 'Quote not found.', status: 404 };
        if (quote.status !== 'sold') {
          return { error: 'Only a sold quote can have its sale reversed.', status: 409 };
        }

        const { saleId, restored } = await reverseSale(tx, quote.id, body.reason);

        await updateQuoteStatus(
          tx,
          quote.id,
          body.moveTo,
          body.moveTo === 'cancelled'
            ? { cancelledAt: new Date(), cancellationReason: body.reason }
            : { reservedAt: quote.reservedAt ?? new Date() },
        );

        await writeAudit(tx, {
          organisationId: auth.organisationId,
          entityType: 'quote',
          entityId: quote.id,
          action: 'sale-reversed',
          fromStatus: 'sold',
          toStatus: body.moveTo,
          note: body.reason,
          actorUserId: auth.userId,
          detail: { saleId, restored },
        });

        return { quote: await getQuote(tx, quote.id, config.staleQuoteDays), restored };
      });

      if ('error' in outcome) return reply.code(outcome.status ?? 409).send({ error: outcome.error });
      return outcome;
    },
  );

  const detailsSchema = z.object({
    priority: z.enum(['high', 'medium', 'low']).optional(),
    notes: z.string().trim().max(5000).nullish(),
    bgsRegisterSubmissionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  });

  app.patch<{ Params: { id: string } }>(
    '/api/quotes/:id',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(detailsSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const outcome = await withTenant(auth.organisationId, async (tx) => {
        const quote = await getQuote(tx, request.params.id, config.staleQuoteDays);
        if (!quote) return null;

        await updateQuoteDetails(tx, quote.id, {
          ...(body.priority ? { priority: body.priority } : {}),
          ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
        });

        // The register submission date is filled in later, after the sale
        // itself (§3.9).
        if (body.bgsRegisterSubmissionDate !== undefined) {
          await updateSaleRegisterDate(tx, quote.id, body.bgsRegisterSubmissionDate ?? null);
        }

        return getQuote(tx, quote.id, config.staleQuoteDays);
      });

      if (!outcome) return reply.code(404).send({ error: 'Quote not found.' });
      return { quote: outcome };
    },
  );

  /** Module-by-module standing against target, for the allocation table. */
  app.get<{ Params: { id: string } }>(
    '/api/quotes/:id/targets',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const quote = await withTenant(auth.organisationId, (tx) =>
        getQuote(tx, request.params.id, config.staleQuoteDays),
      );
      if (!quote) return reply.code(404).send({ error: 'Quote not found.' });
      return { targets: summariseTargets(quote) };
    },
  );
}

export type { MetricModule };
