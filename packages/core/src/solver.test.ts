import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import { UnitQuantity } from './quantity.js';
import { SpatialRiskLookup } from './spatial-multiplier.js';
import {
  meetsTarget,
  percentageToRawQuantity,
  rawQuantityToPercentage,
  solveAllModules,
  solveModule,
  type SolverStockOption,
} from './solver.js';
import type { ShortfallRequirement } from './trading-rules.js';

const lookup = new SpatialRiskLookup();

const shortfall = (over: Partial<ShortfallRequirement> = {}): ShortfallRequirement => ({
  module: 'area',
  broadHabitat: 'Grassland',
  habitatType: 'Other neutral grassland',
  distinctiveness: 'medium',
  ...over,
});

const option = (over: Partial<SolverStockOption> = {}): SolverStockOption => ({
  stockParcelId: `parcel-${over.parcelReference ?? 'P1'}`,
  siteId: 'site-1',
  siteName: 'Home Farm',
  parcelReference: 'P1',
  module: 'area',
  broadHabitat: 'Grassland',
  habitatType: 'Other neutral grassland',
  distinctiveness: 'medium',
  condition: 'moderate',
  availableUnits: UnitQuantity.of('area', '10.0'),
  listPricePerUnit: Money.of('20000'),
  spatialBand: 'same-lpa',
  ...over,
});

describe('eligibility filtering (§4.3.1)', () => {
  it('drops stock the trading rules reject, and says why', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '5.0'),
      shortfall: shortfall({ distinctiveness: 'medium' }),
      options: [
        option({ parcelReference: 'GOOD', distinctiveness: 'medium' }),
        option({ parcelReference: 'TOO-LOW', distinctiveness: 'low' }),
        option({ parcelReference: 'WRONG-GROUP', broadHabitat: 'Woodland and forest', distinctiveness: 'high' }),
      ],
    });

    expect(solution.options.map((o) => o.parcelReference)).toEqual(['GOOD']);
    expect(solution.rejected.map((r) => r.parcelReference).sort()).toEqual(['TOO-LOW', 'WRONG-GROUP']);
    expect(solution.rejected[0]?.reason.length).toBeGreaterThan(30);
  });

  it('never offers stock from another module', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '5.0'),
      shortfall: shortfall(),
      options: [option({ parcelReference: 'HEDGE', module: 'hedgerow' })],
    });
    expect(solution.options).toHaveLength(0);
  });

  it('ignores parcels with nothing left available', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [option({ parcelReference: 'EMPTY', availableUnits: UnitQuantity.of('area', '0') })],
    });
    expect(solution.options).toHaveLength(0);
  });

  it('carries each option’s justification through for storing on the line (§3.8)', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [option()],
    });
    expect(solution.options[0]?.tradingRuleJustification).toContain('Other neutral grassland');
  });
});

describe('buffered target (§4.3.4)', () => {
  it('sits just above the shortfall, not exactly on it', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '10.0'),
      shortfall: shortfall(),
      options: [option()],
    });
    // 10.0 plus the default 0.1% buffer.
    expect(solution.bufferedTargetUnits.toString()).toBe('10.0100');
    expect(solution.bufferedTargetUnits.greaterThan(solution.requiredUnits)).toBe(true);
  });

  it('honours a confirmed buffer without code changes', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '10.0'),
      shortfall: shortfall(),
      options: [option()],
      bufferPercent: '1',
    });
    expect(solution.bufferedTargetUnits.toString()).toBe('10.1000');
  });
});

describe('spatial multipliers (§4.3.2)', () => {
  it('reports how many raw units each option needs per effective unit', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [
        option({ parcelReference: 'NEAR', spatialBand: 'same-lpa' }),
        option({ parcelReference: 'FAR', spatialBand: 'outside' }),
      ],
    });

    const near = solution.options.find((o) => o.parcelReference === 'NEAR');
    const far = solution.options.find((o) => o.parcelReference === 'FAR');
    expect(near?.rawUnitsPerEffectiveUnit).toBe('1');
    expect(far?.rawUnitsPerEffectiveUnit).toBe('2');
    // A distant parcel delivers only half of what it holds.
    expect(far?.maximumEffectiveUnits.toString()).toBe('5.0000');
  });

  it('prices an option by what it truly costs per effective unit', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [option({ parcelReference: 'FAR', spatialBand: 'outside', listPricePerUnit: Money.of('10000') })],
    });
    // £10,000 a unit, but two raw units per effective one.
    expect(solution.options[0]?.effectiveCostPerUnit?.toString()).toBe('20000.00');
  });
});

describe('ranking (§4.3.3)', () => {
  it('spends the lowest-distinctiveness stock first, keeping better stock free', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall({ distinctiveness: 'low' }),
      options: [
        option({ parcelReference: 'HIGH', distinctiveness: 'high' }),
        option({ parcelReference: 'LOW', distinctiveness: 'low' }),
        option({ parcelReference: 'MEDIUM', distinctiveness: 'medium' }),
      ],
    });
    expect(solution.options.map((o) => o.parcelReference)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
  });

  it('breaks a distinctiveness tie on true cost after the multiplier, not list price', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [
        // Cheaper on paper, but distant, so dearer per effective unit.
        option({ parcelReference: 'CHEAP-FAR', listPricePerUnit: Money.of('12000'), spatialBand: 'outside' }),
        option({ parcelReference: 'DEARER-NEAR', listPricePerUnit: Money.of('20000'), spatialBand: 'same-lpa' }),
      ],
    });
    expect(solution.options.map((o) => o.parcelReference)).toEqual(['DEARER-NEAR', 'CHEAP-FAR']);
  });

  it('sorts unpriced stock last, so a suggestion never leans on it unnoticed', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [
        option({ parcelReference: 'UNPRICED', listPricePerUnit: null }),
        option({ parcelReference: 'PRICED', listPricePerUnit: Money.of('30000') }),
      ],
    });
    expect(solution.options.map((o) => o.parcelReference)).toEqual(['PRICED', 'UNPRICED']);
  });

  it('is deterministic for identical options', () => {
    const options = [option({ parcelReference: 'B' }), option({ parcelReference: 'A' })];
    const first = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options,
    });
    const second = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [...options].reverse(),
    });
    expect(first.options.map((o) => o.parcelReference)).toEqual(second.options.map((o) => o.parcelReference));
  });
});

describe('suggested split (§4.3.4–§4.3.5)', () => {
  it('clears the buffered target', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '5.0'),
      shortfall: shortfall(),
      options: [option({ availableUnits: UnitQuantity.of('area', '20.0') })],
    });

    expect(solution.shortOfTarget).toBe(false);
    expect(solution.suggestedEffectiveUnits.greaterThanOrEqual(solution.bufferedTargetUnits)).toBe(true);
    expect(solution.suggested).toHaveLength(1);
    expect(solution.suggested[0]?.rawQuantity.toString()).toBe('5.0050');
  });

  it('draws more raw units from a distant parcel to deliver the same target', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '5.0'),
      shortfall: shortfall(),
      options: [option({ spatialBand: 'outside', availableUnits: UnitQuantity.of('area', '20.0') })],
    });
    // Twice the raw units, for the same effective delivery.
    expect(solution.suggested[0]?.rawQuantity.toString()).toBe('10.0100');
    expect(solution.suggestedEffectiveUnits.greaterThanOrEqual(solution.bufferedTargetUnits)).toBe(true);
  });

  it('spreads across parcels when the first cannot cover the target alone', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '10.0'),
      shortfall: shortfall({ distinctiveness: 'low' }),
      options: [
        option({ parcelReference: 'FIRST', distinctiveness: 'low', availableUnits: UnitQuantity.of('area', '4.0') }),
        option({ parcelReference: 'SECOND', distinctiveness: 'medium', availableUnits: UnitQuantity.of('area', '30.0') }),
      ],
    });

    expect(solution.suggested).toHaveLength(2);
    expect(solution.suggested[0]?.rawQuantity.toString()).toBe('4.0000');
    expect(solution.shortOfTarget).toBe(false);
    expect(solution.suggestedEffectiveUnits.greaterThanOrEqual(solution.bufferedTargetUnits)).toBe(true);
  });

  it('never draws more from a parcel than it has', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '50.0'),
      shortfall: shortfall(),
      options: [option({ availableUnits: UnitQuantity.of('area', '3.0') })],
    });
    expect(solution.suggested[0]?.rawQuantity.toString()).toBe('3.0000');
  });

  it('reports being short rather than pretending to have solved it', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '50.0'),
      shortfall: shortfall(),
      options: [option({ availableUnits: UnitQuantity.of('area', '3.0') })],
    });

    expect(solution.shortOfTarget).toBe(true);
    expect(solution.unmetUnits.toString()).toBe('47.0500');
  });

  it('is short with no eligible stock at all', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '5.0'),
      shortfall: shortfall({ distinctiveness: 'very-high', habitatType: 'Lowland fens' }),
      options: [option()],
    });
    expect(solution.options).toHaveLength(0);
    expect(solution.suggested).toHaveLength(0);
    expect(solution.shortOfTarget).toBe(true);
  });

  it('hands over every eligible option, not only the ones it used (§4.3.5)', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '1.0'),
      shortfall: shortfall(),
      options: [
        option({ parcelReference: 'USED', availableUnits: UnitQuantity.of('area', '50.0') }),
        option({ parcelReference: 'SPARE-A' }),
        option({ parcelReference: 'SPARE-B' }),
      ],
    });

    expect(solution.suggested).toHaveLength(1);
    expect(solution.options).toHaveLength(3);
  });

  it('prices the suggested lines from the parcel’s list price', () => {
    const solution = solveModule({
      module: 'area',
      requiredUnits: UnitQuantity.of('area', '2.0'),
      shortfall: shortfall(),
      options: [option({ listPricePerUnit: Money.of('20000'), availableUnits: UnitQuantity.of('area', '10.0') })],
    });

    const line = solution.suggested[0];
    expect(line?.unitPrice?.toString()).toBe('20000.00');
    expect(line?.lineTotal?.toString()).toBe('40040.00');
  });
});

describe('the three modules stay separate', () => {
  it('solves each independently and never returns a combined figure', () => {
    const solutions = solveAllModules([
      {
        module: 'area',
        requiredUnits: UnitQuantity.of('area', '5.0'),
        shortfall: shortfall(),
        options: [option({ availableUnits: UnitQuantity.of('area', '20.0') })],
      },
      {
        module: 'hedgerow',
        requiredUnits: UnitQuantity.of('hedgerow', '2.0'),
        shortfall: shortfall({ module: 'hedgerow', broadHabitat: 'Hedgerow', habitatType: 'Native hedgerow' }),
        options: [
          option({
            module: 'hedgerow',
            broadHabitat: 'Hedgerow',
            habitatType: 'Native hedgerow',
            availableUnits: UnitQuantity.of('hedgerow', '10.0'),
          }),
        ],
      },
    ]);

    expect(solutions.area?.bufferedTargetUnits.toString()).toBe('5.0050');
    expect(solutions.hedgerow?.bufferedTargetUnits.toString()).toBe('2.002');
    expect(solutions.watercourse).toBeUndefined();
  });

  it('refuses a shortfall from a different module than the one being solved', () => {
    expect(() =>
      solveModule({
        module: 'area',
        requiredUnits: UnitQuantity.of('hedgerow', '5.0'),
        shortfall: shortfall(),
        options: [],
      }),
    ).toThrow(/hedgerow quantity but the module is area/);
  });
});

describe('percentage and quantity conversion for the allocation table (§4.4)', () => {
  const target = UnitQuantity.of('area', '10.0');

  it('converts a share of the target into raw units, accounting for the multiplier', () => {
    expect(percentageToRawQuantity(target, 60, 'same-lpa', lookup).toString()).toBe('6.0000');
    // The same 60% from a distant parcel costs twice the raw units.
    expect(percentageToRawQuantity(target, 60, 'outside', lookup).toString()).toBe('12.0000');
  });

  it('converts raw units back into a share of the target', () => {
    expect(rawQuantityToPercentage(target, UnitQuantity.of('area', '6.0'), 'same-lpa', lookup)).toBe('60.00');
    expect(rawQuantityToPercentage(target, UnitQuantity.of('area', '12.0'), 'outside', lookup)).toBe('60.00');
  });

  it('round-trips without losing the share', () => {
    for (const percent of [10, 25, 33, 50, 66, 75, 100]) {
      for (const band of ['same-lpa', 'neighbouring-lpa-same-nca', 'outside'] as const) {
        const raw = percentageToRawQuantity(target, percent, band, lookup);
        expect(Number(rawQuantityToPercentage(target, raw, band, lookup))).toBeGreaterThanOrEqual(percent);
      }
    }
  });

  it('treats a zero target as zero per cent rather than dividing by it', () => {
    expect(rawQuantityToPercentage(UnitQuantity.zero('area'), UnitQuantity.of('area', '1.0'), 'same-lpa')).toBe(
      '0.00',
    );
  });
});

describe('the hard target gate (§4.4)', () => {
  const target = UnitQuantity.of('area', '10.0100');

  it('passes when the rows clear the target', () => {
    const result = meetsTarget(target, [
      { effectiveUnits: UnitQuantity.of('area', '6.0') },
      { effectiveUnits: UnitQuantity.of('area', '4.011') },
    ]);
    expect(result.meets).toBe(true);
    expect(result.shortBy.isZero()).toBe(true);
  });

  it('fails, and says by how much, when they do not', () => {
    const result = meetsTarget(target, [{ effectiveUnits: UnitQuantity.of('area', '9.0') }]);
    expect(result.meets).toBe(false);
    expect(result.shortBy.toString()).toBe('1.0100');
  });

  it('fails on an empty table', () => {
    expect(meetsTarget(target, []).meets).toBe(false);
  });

  it('passes when exactly on the target', () => {
    expect(meetsTarget(target, [{ effectiveUnits: target }]).meets).toBe(true);
  });
});
