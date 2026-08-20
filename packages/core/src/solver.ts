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
  /**
   * False when the habitat lost was not described, so nothing was filtered.
   * The caller must surface this: an unfiltered list looks exactly like a
   * filtered one that happened to reject nothing.
   */
  tradingRulesApplied: boolean;
}

export interface SolveInput {
  module: MetricModule;
  /** The off-site shortfall for this module, in effective units. */
  requiredUnits: UnitQuantity;
  /**
   * What was lost, which decides what may replace it.
   *
   * Optional, because the manual entry path (§4.4) may not know it — an early
   * enquiry can be no more than a number of units. When it is absent no
   * trading-rule filtering happens, every parcel in the module is offered, and
   * `tradingRulesApplied` on the result says so. That is deliberately louder
   * than filtering on a guess would be.
   */
  shortfall?: ShortfallRequirement | undefined;
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
  if (shortfall && shortfall.module !== module) {
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

    // With no description of the habitat lost there is nothing to test
    // against, so every parcel in the module is offered and the justification
    // records why no rule was applied rather than implying one passed.
    const verdict = shortfall
      ? checkEligibility(option, shortfall, tradingRules)
      : {
          eligible: true,
          justification:
            'The habitat lost was not described, so no trading rule was applied. Confirm this stock is eligible before issuing the quote.',
        };

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
    tradingRulesApplied: shortfall !== undefined,
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
 * The four conversions the allocation table runs on, expressed in terms of a
 * bare delivery factor rather than a band and a scheme.
 *
 * They take the factor directly so the browser can use them without holding a
 * copy of the multiplier scheme: the API sends each option's factor alongside
 * it, and the same functions then run on both sides. That matters more than it
 * might seem — the table converts between units and percentages on every
 * keystroke, and a second implementation in the client would be a second set of
 * rounding decisions applied to the numbers this system exists to keep exact.
 */

/** Effective units delivered by drawing `raw` from a parcel with this factor. */
export function effectiveFromRaw(raw: UnitQuantity, factor: string | Decimal): UnitQuantity {
  // Rounded down: a row must never claim more delivery than its multiplier yields.
  return raw.times(factor, 'down');
}

/** Raw units needed from a parcel with this factor to deliver `effective`. */
export function rawFromEffective(effective: UnitQuantity, factor: string | Decimal): UnitQuantity {
  // Rounded up, for the same reason in the opposite direction.
  return effective.dividedBy(factor, 'up');
}

/** Raw units this parcel must give up to supply `percent` of the target. */
export function percentToRaw(
  target: UnitQuantity,
  percent: string | number,
  factor: string | Decimal,
): UnitQuantity {
  const share = new Decimal(percent).dividedBy(100);
  // Rounded up at both steps: a row asked to supply 60% of the target must not
  // come back supplying 59.99%.
  return rawFromEffective(target.times(share, 'up'), factor);
}

/** The share of the target that `raw` from this parcel actually supplies. */
export function rawToPercent(
  target: UnitQuantity,
  raw: UnitQuantity,
  factor: string | Decimal,
): string {
  if (target.isZero()) return '0.00';
  return effectiveFromRaw(raw, factor)
    .toDecimal()
    .dividedBy(target.toDecimal())
    .times(100)
    .toDecimalPlaces(2)
    .toFixed(2);
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
  return percentToRaw(target, percent, lookup.deliveryFactor(band));
}

export function rawQuantityToPercentage(
  target: UnitQuantity,
  rawQuantity: UnitQuantity,
  band: LpaNcaBand,
  lookup: SpatialRiskLookup = new SpatialRiskLookup(),
): string {
  return rawToPercent(target, rawQuantity, lookup.deliveryFactor(band));
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
