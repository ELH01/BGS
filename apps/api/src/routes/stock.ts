import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CONDITION_BANDS,
  DISTINCTIVENESS_BANDS,
  METRIC_MODULES,
  Money,
  UnitQuantity,
} from '@bgs/core';
import { checkParcelExportReadiness } from '@bgs/metric';
import {
  createStockParcel,
  getStockUnitPool,
  listStockParcels,
  setStockParcelListPrice,
  updateStockParcelMetricInputs,
  withTenant,
  type StockParcel,
} from '@bgs/db';
import { describeDatabaseError, parseBody } from '../http.js';

/**
 * Unit quantities are accepted as strings only, never as JSON numbers.
 *
 * `JSON.parse` turns a numeric literal into a double, so a quantity sent as
 * 2.3457 has already lost its exactness before any validation could run. A
 * string arrives intact and is converted by `UnitQuantity`, which is the only
 * thing in the system allowed to decide precision.
 */
const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, 'Enter a plain decimal number, e.g. 2.3457.');

const moneyString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount in pounds and pence, e.g. 12500.00.');

const STRATEGIC_SIGNIFICANCE = ['formally-identified', 'ecologically-desirable', 'not-in-strategy'] as const;

/** Years, to two decimal places; the metric accepts part years. */
const yearsString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'Enter a number of years, e.g. 3 or 3.5.');

const parcelSchema = z.object({
  organisationId: z.string().uuid().optional(),
  siteId: z.string().uuid(),
  parcelReference: z.string().trim().min(1).max(100),
  module: z.enum(METRIC_MODULES),
  broadHabitat: z.string().trim().min(1).max(200),
  habitatType: z.string().trim().min(1).max(200),
  distinctiveness: z.enum(DISTINCTIVENESS_BANDS),
  condition: z.enum(CONDITION_BANDS).default('n/a'),
  totalUnits: decimalString,
  listPricePerUnit: moneyString.nullish(),
  // Inputs the metric uses to compute units. Held on the parcel so an
  // allocation written into a developer's workbook reproduces the same
  // calculation the bank's own metric made.
  extent: decimalString.nullish(),
  strategicSignificance: z.enum(STRATEGIC_SIGNIFICANCE).nullish(),
  habitatCreatedInAdvanceYears: yearsString.nullish(),
  delayYears: yearsString.nullish(),
  notes: z.string().trim().max(5000).nullish(),
});

const metricInputsSchema = z.object({
  extent: decimalString.nullish(),
  strategicSignificance: z.enum(STRATEGIC_SIGNIFICANCE).nullish(),
  habitatCreatedInAdvanceYears: yearsString.nullish(),
  delayYears: yearsString.nullish(),
});

/**
 * Whether a parcel carries everything a developer's metric needs.
 *
 * Reported alongside the parcel so a missing figure shows up on the stock
 * screen, rather than surfacing when someone is trying to send a workbook to a
 * client.
 */
function exportReadiness(parcel: StockParcel) {
  return checkParcelExportReadiness({
    reference: parcel.parcelReference,
    broadHabitat: parcel.broadHabitat,
    habitatType: parcel.habitatType,
    condition: parcel.condition,
    strategicSignificance: parcel.strategicSignificance,
    totalUnits: parcel.totalUnits,
    extent: parcel.extent,
    habitatCreatedInAdvanceYears: parcel.habitatCreatedInAdvanceYears,
    delayYears: parcel.delayYears,
  });
}

const listPriceSchema = z.object({
  listPricePerUnit: moneyString.nullable(),
});

export default async function stockRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { siteId?: string; module?: string } }>(
    '/api/stock-parcels',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const module = request.query.module;
      if (module && !(METRIC_MODULES as readonly string[]).includes(module)) {
        return reply.code(400).send({ error: `Unknown module "${module}".` });
      }

      const parcels = await withTenant(auth.organisationId, (tx) =>
        listStockParcels(tx, {
          ...(request.query.siteId ? { siteId: request.query.siteId } : {}),
          ...(module ? { module: module as (typeof METRIC_MODULES)[number] } : {}),
        }),
      );
      return {
        stockParcels: parcels.map((parcel) => ({ ...parcel, exportReadiness: exportReadiness(parcel) })),
      };
    },
  );

  /**
   * Create a stock parcel by hand.
   *
   * The specification's phase 1 calls for this as the fallback for when a
   * given workbook layout cannot be parsed reliably; it is also how stock gets
   * in at all until real sample workbooks are available to build the parser
   * against (§5.1).
   */
  app.post('/api/stock-parcels', { onRequest: [app.requireWriteAccess] }, async (request, reply) => {
    const body = parseBody(parcelSchema, request.body, reply);
    if (!body) return;
    const auth = request.auth!;

    let totalUnits: UnitQuantity;
    try {
      totalUnits = UnitQuantity.parse(body.module, body.totalUnits);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    try {
      const parcel = await withTenant(auth.organisationId, (tx) =>
        createStockParcel(tx, {
          organisationId: body.organisationId ?? auth.organisationId,
          siteId: body.siteId,
          parcelReference: body.parcelReference,
          module: body.module,
          broadHabitat: body.broadHabitat,
          habitatType: body.habitatType,
          distinctiveness: body.distinctiveness,
          condition: body.condition,
          totalUnits,
          listPricePerUnit: body.listPricePerUnit ? Money.parse(body.listPricePerUnit) : null,
          extent: body.extent ?? null,
          strategicSignificance: body.strategicSignificance ?? null,
          habitatCreatedInAdvanceYears: body.habitatCreatedInAdvanceYears ?? null,
          delayYears: body.delayYears ?? null,
          notes: body.notes ?? null,
        }),
      );
      return reply.code(201).send({ stockParcel: { ...parcel, exportReadiness: exportReadiness(parcel) } });
    } catch (error) {
      const described = describeDatabaseError(error);
      if (described) {
        const message =
          described.status === 409
            ? 'A parcel with that reference already exists for this site and module.'
            : described.message;
        return reply.code(described.status).send({ error: message });
      }
      throw error;
    }
  });

  /** §3.3: list price is set by the user after import, never parsed from the metric. */
  app.put<{ Params: { id: string } }>(
    '/api/stock-parcels/:id/list-price',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(listPriceSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const parcel = await withTenant(auth.organisationId, (tx) =>
        setStockParcelListPrice(
          tx,
          request.params.id,
          body.listPricePerUnit === null ? null : Money.parse(body.listPricePerUnit),
        ),
      );
      if (!parcel) return reply.code(404).send({ error: 'Stock parcel not found.' });
      return { stockParcel: parcel };
    },
  );

  /**
   * Fill in the metric inputs, which often arrive after the parcel itself.
   */
  app.put<{ Params: { id: string } }>(
    '/api/stock-parcels/:id/metric-inputs',
    { onRequest: [app.requireWriteAccess] },
    async (request, reply) => {
      const body = parseBody(metricInputsSchema, request.body, reply);
      if (!body) return;
      const auth = request.auth!;

      const parcel = await withTenant(auth.organisationId, (tx) =>
        updateStockParcelMetricInputs(tx, request.params.id, {
          extent: body.extent ?? null,
          strategicSignificance: body.strategicSignificance ?? null,
          habitatCreatedInAdvanceYears: body.habitatCreatedInAdvanceYears ?? null,
          delayYears: body.delayYears ?? null,
        }),
      );
      if (!parcel) return reply.code(404).send({ error: 'Stock parcel not found.' });
      return { stockParcel: { ...parcel, exportReadiness: exportReadiness(parcel) } };
    },
  );

  /** §3.4 / §4.4: the unit pool, and the exposure figures derived from it. */
  app.get<{ Querystring: { siteId?: string; module?: string } }>(
    '/api/stock-pool',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      const auth = request.auth!;
      const module = request.query.module;
      if (module && !(METRIC_MODULES as readonly string[]).includes(module)) {
        return reply.code(400).send({ error: `Unknown module "${module}".` });
      }

      const pool = await withTenant(auth.organisationId, (tx) =>
        getStockUnitPool(tx, {
          ...(request.query.siteId ? { siteId: request.query.siteId } : {}),
          ...(module ? { module: module as (typeof METRIC_MODULES)[number] } : {}),
        }),
      );
      return { pool };
    },
  );
}
