import { describe, expect, it } from 'vitest';
import { UnitQuantity } from '@bgs/core';
import {
  allocationRowFromParcel,
  checkParcelExportReadiness,
  extentForAllocation,
  type ParcelForExport,
} from './off-site-export.js';
import { METRIC_4_0_LABELS, conditionLabel, spatialRiskLabel, strategicSignificanceLabel } from './labels.js';

const parcel = (over: Partial<ParcelForExport> = {}): ParcelForExport => ({
  reference: 'CC-F1',
  broadHabitat: 'Grassland',
  habitatType: 'Other neutral grassland',
  condition: 'moderate',
  strategicSignificance: 'formally-identified',
  totalUnits: UnitQuantity.of('area', '11.7285'),
  extent: '5.0',
  habitatCreatedInAdvanceYears: '3',
  delayYears: '0',
  ...over,
});

describe('the workbook computes the units, so it needs every input', () => {
  it('writes the metric inputs the parcel was valued on', () => {
    const row = allocationRowFromParcel(parcel(), {
      allocatedUnits: UnitQuantity.of('area', '2.3457'),
      spatialBand: 'outside',
    });

    expect(row.habitatType).toBe('Other neutral grassland');
    expect(row.condition).toBe(conditionLabel('moderate'));
    expect(row.strategicSignificance).toBe(strategicSignificanceLabel('formally-identified'));
    expect(row.spatialRiskCategory).toBe(spatialRiskLabel('outside'));
    expect(row.createdInAdvanceYears).toBe('3');
    expect(row.delayYears).toBe('0');
  });

  it('converts stored slugs into the words the workbook’s dropdowns use', () => {
    const row = allocationRowFromParcel(parcel({ condition: 'fairly-good' }), {
      allocatedUnits: UnitQuantity.of('area', '1.0'),
      spatialBand: 'same-lpa',
    });
    // Never the internal slug: the metric's lookup would not recognise it.
    expect(row.condition).toBe('Fairly Good');
    expect(row.condition).not.toContain('-');
  });

  it('states a zero rather than leaving the temporal cells empty', () => {
    const row = allocationRowFromParcel(
      parcel({ habitatCreatedInAdvanceYears: null, delayYears: null }),
      { allocatedUnits: UnitQuantity.of('area', '1.0'), spatialBand: 'same-lpa' },
    );
    // An empty cell and a stated zero are not the same to the metric.
    expect(row.createdInAdvanceYears).toBe('0');
    expect(row.delayYears).toBe('0');
  });

  it('does not apply the spatial multiplier itself — the workbook does', () => {
    // The extent written is the plain physical share of the parcel. The
    // multiplier reaches the workbook as the spatial risk category alongside
    // it, so applying it here as well would deduct it twice.
    const distant = allocationRowFromParcel(parcel(), {
      allocatedUnits: UnitQuantity.of('area', '2.3457'),
      spatialBand: 'outside',
    });
    const near = allocationRowFromParcel(parcel(), {
      allocatedUnits: UnitQuantity.of('area', '2.3457'),
      spatialBand: 'same-lpa',
    });

    expect(extentForAllocation(distant)).toBe(extentForAllocation(near));
    expect(extentForAllocation(distant)).toBe('1.000000');
    expect(distant.spatialRiskCategory).not.toBe(near.spatialRiskCategory);
  });

  it('refuses to write a parcel with no strategic significance', () => {
    expect(() =>
      allocationRowFromParcel(parcel({ strategicSignificance: null }), {
        allocatedUnits: UnitQuantity.of('area', '1.0'),
        spatialBand: 'same-lpa',
      }),
    ).toThrow(/different figure from the one quoted/);
  });

  it('refuses to write a parcel with no extent', () => {
    expect(() =>
      allocationRowFromParcel(parcel({ extent: null }), {
        allocatedUnits: UnitQuantity.of('area', '1.0'),
        spatialBand: 'same-lpa',
      }),
    ).toThrow(/no extent recorded/);
  });
});

describe('export readiness', () => {
  it('passes a fully recorded parcel', () => {
    expect(checkParcelExportReadiness(parcel())).toEqual({ ready: true, missing: [] });
  });

  it('names each missing input in plain words', () => {
    const result = checkParcelExportReadiness(
      parcel({ extent: null, strategicSignificance: null, habitatCreatedInAdvanceYears: null }),
    );

    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      'physical extent (hectares or kilometres)',
      'strategic significance',
      'years the habitat was created in advance',
    ]);
  });

  it('flags an empty extent string as missing, not merely null', () => {
    expect(checkParcelExportReadiness(parcel({ extent: '  ' })).ready).toBe(false);
  });

  it('flags a parcel that generates no units', () => {
    const result = checkParcelExportReadiness(parcel({ totalUnits: UnitQuantity.of('area', '0') }));
    expect(result.missing).toContain('units (the parcel generates none)');
  });

  it('treats missing years-in-advance as a gap, since silence understates a bank parcel', () => {
    const result = checkParcelExportReadiness(parcel({ habitatCreatedInAdvanceYears: null }));
    expect(result.ready).toBe(false);
  });
});

describe('dropdown labels', () => {
  it('ships marked unconfirmed, since a wrong label fails silently', () => {
    expect(METRIC_4_0_LABELS.status).toBe('unconfirmed');
    expect(METRIC_4_0_LABELS.source).toMatch(/fails silently/);
  });

  it('covers every stored value', () => {
    for (const slug of ['n/a', 'poor', 'fairly-poor', 'moderate', 'fairly-good', 'good'] as const) {
      expect(conditionLabel(slug).length).toBeGreaterThan(0);
    }
    for (const slug of ['formally-identified', 'ecologically-desirable', 'not-in-strategy'] as const) {
      expect(strategicSignificanceLabel(slug).length).toBeGreaterThan(0);
    }
    for (const band of ['same-lpa', 'neighbouring-lpa-same-nca', 'outside'] as const) {
      expect(spatialRiskLabel(band).length).toBeGreaterThan(0);
    }
  });

  it('never leaks a slug into a label', () => {
    const labels = [
      ...Object.values(METRIC_4_0_LABELS.condition),
      ...Object.values(METRIC_4_0_LABELS.strategicSignificance),
      ...Object.values(METRIC_4_0_LABELS.spatialRisk),
    ];
    for (const label of labels) {
      expect(label).not.toMatch(/^[a-z]+(-[a-z]+)+$/);
    }
  });

  it('refuses an unknown metric version rather than guessing at wording', () => {
    expect(() => conditionLabel('good', '3.1')).toThrow(/No dropdown labels for metric version/);
  });
});
