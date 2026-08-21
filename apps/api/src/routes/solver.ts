import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DISTINCTIVENESS_BANDS,
  METRIC_MODULES,
  SpatialRiskLookup,
  UnitQuantity,
  solveModule,
  type SolverStockOption,
} from '@bgs/core';
import { getDeveloper, getSolverStock, withTenant } from '@bgs/db';
import { loadApiConfig } from '../env.js';
import { parseBody } from '../http.js';

const solveSchema = z.object({
  module: z.enum(METRIC_MODULES),
  /** The off-site shortfall for this module, in effective units. */
  requiredUnits: z.string().trim().regex(/^\d+(\.\d+)?$/, 'Enter a plain decimal number.'),
  /**
   * What was lost, which decides what may lawfully replace it.
   *
   * Optional: an early enquiry may be no more than a number of units. Omitted,
   * every parcel in the module is returned and `tradingRulesApplied` is false,
   * so the caller can say so rather than presenting an unfiltered list as a
   * filtered one.
   */
  shortfall: z
    .object({
      broadHabitat: z.string().trim().min(1).max(200),
      habitatType: z.string().trim().min(1).max(200),
      distinctiveness: z.enum(DISTINCTIVENESS_BANDS),
    })
    .nullish(),
  /** Whose development this is, for the spatial risk lookup. */
  developerId: z.string().uuid(),
  /** Optionally scope to one site rather than searching every bank (§4.3.1). */
  siteId: z.string().uuid().optional(),
  /**
   * Scope to one operator's stock.
   *
   * A quote supplies one operator, so the allocation table passes the quote's
   * own operator here and never offers stock the quote could not use.
   */
  bankOperatorId: z.string().uuid().optional(),
  /**
   * LPAs adjacent to the development's own. Adjacency is reference data this
   * platform does not hold, so the caller supplies it; without it, a bank in a
   * different LPA is treated as outside.
   */
  neighbouringLpas: z.array(z.string().trim().max(50)).max(100).optional(),
});

export default async function solverRoutes(app: FastifyInstance): Promise<void> {
  const config = loadApiConfig();
  const lookup = new SpatialRiskLookup();

  /**
   * Surface the eligible stock for a shortfall, with a suggested split (§4.3).
   *
   * Deliberately read-only. It proposes; the user disposes in the allocation
   * table, and nothing is committed until they confirm it.
   */
  app.post('/api/allocation-options', { onRequest: [app.requireAuth] }, async (request, reply) => {
    const body = parseBody(solveSchema, request.body, reply);
    if (!body) return;
    const auth = request.auth!;

    const outcome = await withTenant(auth.organisationId, async (tx) => {
      const developer = await getDeveloper(tx, body.developerId);
      if (!developer) return null;

      const stock = await getSolverStock(tx, {
        module: body.module,
        ...(body.siteId ? { siteId: body.siteId } : {}),
        ...(body.bankOperatorId ? { bankOperatorId: body.bankOperatorId } : {}),
      });

      const options: SolverStockOption[] = stock.map((row) => ({
        stockParcelId: row.stockParcelId,
        siteId: row.siteId,
        siteName: row.siteName,
        parcelReference: row.parcelReference,
        module: row.module,
        broadHabitat: row.broadHabitat,
        habitatType: row.habitatType,
        distinctiveness: row.distinctiveness,
        condition: row.condition,
        availableUnits: row.availableUnits,
        listPricePerUnit: row.listPricePerUnit,
        spatialBand: SpatialRiskLookup.classify({
          bankLpa: row.siteLpaCode ?? '',
          bankNca: row.siteNcaCode ?? '',
          developmentLpa: developer.developmentLpaCode ?? '',
          developmentNca: developer.developmentNcaCode ?? '',
          ...(body.neighbouringLpas ? { neighbouringLpas: body.neighbouringLpas } : {}),
        }),
      }));

      return solveModule({
        module: body.module,
        requiredUnits: UnitQuantity.parse(body.module, body.requiredUnits),
        ...(body.shortfall ? { shortfall: { module: body.module, ...body.shortfall } } : {}),
        options,
        lookup,
        bufferPercent: config.netGainBufferPercent,
      });
    });

    if (!outcome) return reply.code(404).send({ error: 'Developer not found.' });

    return {
      module: outcome.module,
      requiredUnits: outcome.requiredUnits.toString(),
      bufferedTargetUnits: outcome.bufferedTargetUnits.toString(),
      // Every eligible option, not only the ones the suggestion used, so the
      // table can be rebalanced freely (§4.3.5).
      options: outcome.options.map((option) => ({
        stockParcelId: option.stockParcelId,
        siteId: option.siteId,
        siteName: option.siteName,
        parcelReference: option.parcelReference,
        broadHabitat: option.broadHabitat,
        habitatType: option.habitatType,
        distinctiveness: option.distinctiveness,
        condition: option.condition,
        availableUnits: option.availableUnits.toString(),
        listPricePerUnit: option.listPricePerUnit?.toString() ?? null,
        spatialBand: option.spatialBand,
        spatialFactor: option.spatialFactor,
        rawUnitsPerEffectiveUnit: option.rawUnitsPerEffectiveUnit,
        maximumEffectiveUnits: option.maximumEffectiveUnits.toString(),
        effectiveCostPerUnit: option.effectiveCostPerUnit?.toString() ?? null,
        tradingRuleJustification: option.tradingRuleJustification,
      })),
      suggested: outcome.suggested.map((line) => ({
        stockParcelId: line.stockParcelId,
        rawQuantity: line.rawQuantity.toString(),
        effectiveUnits: line.effectiveUnits.toString(),
        unitPrice: line.unitPrice?.toString() ?? null,
        lineTotal: line.lineTotal?.toString() ?? null,
      })),
      suggestedEffectiveUnits: outcome.suggestedEffectiveUnits.toString(),
      shortOfTarget: outcome.shortOfTarget,
      unmetUnits: outcome.unmetUnits.toString(),
      // Shown so the user can see what was considered and rejected, rather
      // than wondering why a parcel they expected is missing.
      rejected: outcome.rejected,
      tradingRulesApplied: outcome.tradingRulesApplied,
      spatialScheme: { id: lookup.scheme.id, status: lookup.scheme.status },
    };
  });
}
