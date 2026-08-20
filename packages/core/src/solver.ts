import Decimal from 'decimal.js';
import { distinctivenessRank, type ConditionBand, type DistinctivenessBand } from './distinctiveness.js';
import { Money } from './money.js';
import type { MetricModule } from './modules.js';
import { UnitQuantity } from './quantity.js';
import { SpatialRiskLookup, bufferedTarget, type LpaNcaBand } from './spatial-multiplier.js';
import {
  checkEligibility,
  type ShortfallRequirement,
  type TradingRuleConfig,
  DEFAULT_TRADING_RULES,
} from './trading-rules.js';

/**
 * The allocation solver (§4.3).
 *
 * Its job is deliberately limited: surface every parcel that could lawfully
 * fill a shortfall, work out what each would cost in raw units after its
 * spatial multiplier, and propose one sensible starting split. It does not
 * decide the final mix. The user does that in the allocation table, and the
 * full ranked list is handed over so they can rebalance freely — a hundred per
 * cent from one parcel, or spread across several.
 *
 * The three modules are solved as three independent problems and never
 * blended.
 */

export interface SolverStockOption {
  stockParcelId: string;
  siteId: string;
  siteName: string;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: DistinctivenessBand;
  condition: ConditionBand;
  /** Units still available to allocate from this parcel. */
  availableUnits: UnitQuantity;
  listPricePerUnit: Money | null;
  /** Where this parcel's site sits relative to the development. */
  spatialBand: LpaNcaBand;
}

export interface EligibleOption extends SolverStockOption {
  /** Why this parcel may fill this shortfall, for storing on the line (§3.8). */
  tradingRuleJustification: string;
  /** Factor raw units are multiplied by to give effective units. */
  spatialFactor: string;
  /** Effective units this parcel could deliver if drawn dry. */
  maximumEffectiveUnits: UnitQuantity;
  /**
   * Raw units needed from this parcel per effective unit delivered. Above 1
   * wherever the spatial multiplier bites.
   */
  rawUnitsPerEffectiveUnit: string;
  /** Effective cost per effective unit, once the multiplier is accounted for. */
  effectiveCostPerUnit: Money | null;
}

export interface SuggestedAllocation {
  stockParcelId: string;
  /** Units drawn from the parcel, at the module's precision. */
  rawQuantity: UnitQuantity;
  /** What those raw units deliver after the multiplier. */
  effectiveUnits: UnitQuantity;
  unitPrice: Money | null;
  lineTotal: Money | null;
}

export interface ModuleSolution {
  module: MetricModule;
  /** The shortfall before the buffer. */
  requiredUnits: UnitQuantity;
  /** The figure the allocation must actually clear (§4.3.4). */
  bufferedTargetUnits: UnitQuantity;
  /** Every eligible option, ranked, including those the split does not use. */
  options: EligibleOption[];
  /** A starting point, not a decision. */
  suggested: SuggestedAllocation[];
  /** Effective units the suggested split delivers. */
  suggestedEffectiveUnits: UnitQuantity;
  /** True when eligible stock cannot cover the buffered target. */
  shortOfTarget: boolean;
  /** How far short, when it is. */
  unmetUnits: UnitQuantity;
  /** Parcels rejected by the trading rules, with the reason. */
  rejected: Array<{ stockParcelId: string; parcelReference: string; reason: string }>;
}

export interface SolveInput {
  module: MetricModule;
  /** The off-site shortfall for this module, in effective units. */
  requiredUnits: UnitQuantity;
  /** What was lost, which decides what may replace it. */
  shortfall: ShortfallRequirement;
  options: readonly SolverStockOption[];
  lookup?: SpatialRiskLookup;
  tradingRules?: TradingRuleConfig;
  bufferPercent?: string;
}

/**
 * Rank eligible options cheapest-first (§4.3.3).
 *
 * Lowest distinctiveness leads, so the cheaper stock is spent first and the
 * higher-value parcels stay free for quotes that actually need them. Where
 * distinctiveness ties, genuine cost per effective unit decides — which is the
 * price *after* the spatial multiplier, since a distant parcel needs more raw
 * units to deliver the same effective one and is therefore dearer than its
 * list price suggests.
 */
function rankOptions(a: EligibleOption, b: EligibleOption): number {
  const byDistinctiveness = distinctivenessRank(a.distinctiveness) - distinctivenessRank(b.distinctiveness);
  if (byDistinctiveness !== 0) return byDistinctiveness;

  const priceA = a.effectiveCostPerUnit;
  const priceB = b.effectiveCostPerUnit;
  if (priceA && priceB && !priceA.equals(priceB)) return priceA.lessThan(priceB) ? -1 : 1;
  // A parcel with no price set sorts after one with a price, so the suggested
  // split does not silently lean on stock that has not been priced.
  if (priceA && !priceB) return -1;
  if (!priceA && priceB) return 1;

  // Finally the nearer parcel, then a stable tiebreak so the same inputs always
  // produce the same suggestion.
  const byFactor = Number(b.spatialFactor) - Number(a.spatialFactor);
  if (byFactor !== 0) return byFactor;
  return a.parcelReference.localeCompare(b.parcelReference);
}

export function solveModule(input: SolveInput): ModuleSolution {
  const {
    module,
    requiredUnits,
    shortfall,
    options,
    lookup = new SpatialRiskLookup(),
    tradingRules = DEFAULT_TRADING_RULES,
    bufferPercent,
  } = input;

  if (requiredUnits.module !== module) {
    throw new TypeError(`Required units are a ${requiredUnits.module} quantity but the module is ${module}.`);
  }
  if (shortfall.module !== module) {
    throw new TypeError(`Shortfall is for ${shortfall.module} but the module is ${module}.`);
  }

  // The target is the shortfall lifted just above the statutory line, so that
  // re-rounding on review cannot take it under (§4.3.4).
  const target = bufferedTarget(module, requiredUnits, {
    gainPercent: '100',
    ...(bufferPercent === undefined ? {} : { bufferPercent }),
  });

  const eligible: EligibleOption[] = [];
  const rejected: ModuleSolution['rejected'] = [];

  for (const option of options) {
    if (option.module !== module) continue;

    const verdict = checkEligibility(option, shortfall, tradingRules);
    if (!verdict.eligible) {
      rejected.push({
        stockParcelId: option.stockParcelId,
        parcelReference: option.parcelReference,
        reason: verdict.justification,
      });
      continue;
    }

    if (!option.availableUnits.isPositive()) continue;

    const factor = lookup.deliveryFactor(option.spatialBand);
    const effectiveCostPerUnit = option.listPricePerUnit
      ? option.listPricePerUnit.times(lookup.rawUnitsPerEffectiveUnit(option.spatialBand))
      : null;

    eligible.push({
      ...option,
      tradingRuleJustification: verdict.justification,
      spatialFactor: factor.toString(),
      maximumEffectiveUnits: lookup.effectiveUnits(option.availableUnits, option.spatialBand),
      rawUnitsPerEffectiveUnit: lookup.rawUnitsPerEffectiveUnit(option.spatialBand).toString(),
      effectiveCostPerUnit,
    });
  }

  eligible.sort(rankOptions);

  const suggested: SuggestedAllocation[] = [];
  let delivered = UnitQuantity.zero(module);

  for (const option of eligible) {
    if (delivered.greaterThanOrEqual(target)) break;

    const stillNeeded = target.minus(delivered);
    // What this parcel would have to give up to cover the rest on its own.
    const rawForRemainder = lookup.rawUnitsRequired(stillNeeded, option.spatialBand);
    const rawQuantity = UnitQuantity.min(rawForRemainder, option.availableUnits);
    if (!rawQuantity.isPositive()) continue;

    const effectiveUnits = lookup.effectiveUnits(rawQuantity, option.spatialBand);
    const unitPrice = option.listPricePerUnit;

    suggested.push({
      stockParcelId: option.stockParcelId,
      rawQuantity,
      effectiveUnits,
      unitPrice,
      lineTotal: unitPrice ? Money.lineTotal(unitPrice, rawQuantity) : null,
    });

    delivered = delivered.plus(effectiveUnits);
  }

  const shortOfTarget = delivered.lessThan(target);

  return {
    module,
    requiredUnits,
    bufferedTargetUnits: target,
    options: eligible,
    suggested,
    suggestedEffectiveUnits: delivered,
    shortOfTarget,
    unmetUnits: shortOfTarget ? target.minus(delivered) : UnitQuantity.zero(module),
    rejected,
  };
}

/**
 * Solve all three modules.
 *
 * Returned as a record keyed by module rather than a combined figure, because
 * there is no such thing as a combined figure: each module is its own DEFRA
 * headline and its own regulatory test.
 */
export function solveAllModules(
  inputs: readonly SolveInput[],
): Partial<Record<MetricModule, ModuleSolution>> {
  const solutions: Partial<Record<MetricModule, ModuleSolution>> = {};
  for (const input of inputs) {
    solutions[input.module] = solveModule(input);
  }
  return solutions;
}

/**
 * Convert a percentage of a module's target into raw units from a parcel, and
 * back again — the bidirectional conversion the allocation table needs (§4.4).
 *
 * The user types either a raw quantity or a share of the target, and sees the
 * other; both have to account for that parcel's own multiplier.
 */
export function percentageToRawQuantity(
  target: UnitQuantity,
  percent: string | number,
  band: LpaNcaBand,
  lookup: SpatialRiskLookup = new SpatialRiskLookup(),
): UnitQuantity {
  const share = new Decimal(percent).dividedBy(100);
  // Rounded up at both steps: a row asked to supply 60% of the target must not
  // come back supplying 59.99%.
  const effectiveWanted = target.times(share, 'up');
  return lookup.rawUnitsRequired(effectiveWanted, band);
}

export function rawQuantityToPercentage(
  target: UnitQuantity,
  rawQuantity: UnitQuantity,
  band: LpaNcaBand,
  lookup: SpatialRiskLookup = new SpatialRiskLookup(),
): string {
  if (target.isZero()) return '0.00';
  const effective = lookup.effectiveUnits(rawQuantity, band);
  return effective.toDecimal().dividedBy(target.toDecimal()).times(100).toDecimalPlaces(2).toFixed(2);
}

/**
 * Whether a set of rows clears its module's target — the hard gate a quote
 * cannot pass while it is false (§4.4).
 */
export function meetsTarget(
  target: UnitQuantity,
  rows: ReadonlyArray<{ effectiveUnits: UnitQuantity }>,
): { meets: boolean; delivered: UnitQuantity; shortBy: UnitQuantity } {
  const delivered = UnitQuantity.sum(
    target.module,
    rows.map((row) => row.effectiveUnits),
  );
  const meets = delivered.greaterThanOrEqual(target);
  return {
    meets,
    delivered,
    shortBy: meets ? UnitQuantity.zero(target.module) : target.minus(delivered),
  };
}
