import { describe, expect, it } from 'vitest';
import { UnitQuantity } from './quantity.js';
import {
  PLACEHOLDER_LPA_NCA_SCHEME,
  SpatialRiskLookup,
  bufferedTarget,
  type SpatialRiskScheme,
} from './spatial-multiplier.js';

const lookup = new SpatialRiskLookup();

describe('scheme confirmation gate (spec §5.3)', () => {
  it('ships marked unconfirmed so nothing passes itself off as authoritative', () => {
    expect(PLACEHOLDER_LPA_NCA_SCHEME.status).toBe('unconfirmed');
    expect(lookup.isConfirmed).toBe(false);
    expect(PLACEHOLDER_LPA_NCA_SCHEME.source).toMatch(/pending confirmation/i);
  });

  it('accepts a confirmed scheme supplied through configuration', () => {
    const confirmed: SpatialRiskScheme = {
      id: 'lpa-nca-2026',
      label: 'LPA/NCA spatial risk',
      status: 'confirmed',
      source: 'Verified against current guidance',
      confirmedBy: 'Elliott Hails',
      confirmedOn: '2026-08-20',
      factors: { 'same-lpa': '1.00', 'neighbouring-lpa-same-nca': '0.75', outside: '0.50' },
    };
    expect(new SpatialRiskLookup(confirmed).isConfirmed).toBe(true);
  });

  it('rejects a scheme with an out-of-range factor', () => {
    const bad = { ...PLACEHOLDER_LPA_NCA_SCHEME, factors: { ...PLACEHOLDER_LPA_NCA_SCHEME.factors, outside: '1.5' } };
    expect(() => new SpatialRiskLookup(bad)).toThrow(/greater than 0 and at most 1/);
  });

  it('rejects a zero factor, which would imply infinite stock required', () => {
    const bad = { ...PLACEHOLDER_LPA_NCA_SCHEME, factors: { ...PLACEHOLDER_LPA_NCA_SCHEME.factors, outside: '0' } };
    expect(() => new SpatialRiskLookup(bad)).toThrow(/greater than 0/);
  });
});

describe('band classification', () => {
  it('recognises a bank in the same LPA as the development', () => {
    expect(
      SpatialRiskLookup.classify({
        bankLpa: 'E07000040',
        bankNca: 'NCA148',
        developmentLpa: 'E07000040',
        developmentNca: 'NCA148',
      }),
    ).toBe('same-lpa');
  });

  it('recognises a neighbouring LPA within the same NCA', () => {
    expect(
      SpatialRiskLookup.classify({
        bankLpa: 'E07000041',
        bankNca: 'NCA148',
        developmentLpa: 'E07000040',
        developmentNca: 'NCA148',
        neighbouringLpas: ['E07000041', 'E07000042'],
      }),
    ).toBe('neighbouring-lpa-same-nca');
  });

  it('treats a neighbouring LPA in a different NCA as outside', () => {
    expect(
      SpatialRiskLookup.classify({
        bankLpa: 'E07000041',
        bankNca: 'NCA999',
        developmentLpa: 'E07000040',
        developmentNca: 'NCA148',
        neighbouringLpas: ['E07000041'],
      }),
    ).toBe('outside');
  });

  it('treats a same-NCA but non-neighbouring LPA as outside', () => {
    expect(
      SpatialRiskLookup.classify({
        bankLpa: 'E07000099',
        bankNca: 'NCA148',
        developmentLpa: 'E07000040',
        developmentNca: 'NCA148',
        neighbouringLpas: ['E07000041'],
      }),
    ).toBe('outside');
  });

  it('defaults to outside when no neighbour list is supplied', () => {
    expect(
      SpatialRiskLookup.classify({
        bankLpa: 'E07000041',
        bankNca: 'NCA148',
        developmentLpa: 'E07000040',
        developmentNca: 'NCA148',
      }),
    ).toBe('outside');
  });
});

describe('the two readings of the multiplier are reciprocal', () => {
  it('exposes both the delivery factor and units-per-effective-unit', () => {
    expect(lookup.deliveryFactor('outside').toString()).toBe('0.5');
    expect(lookup.rawUnitsPerEffectiveUnit('outside').toString()).toBe('2');
    expect(lookup.deliveryFactor('same-lpa').toString()).toBe('1');
    expect(lookup.rawUnitsPerEffectiveUnit('same-lpa').toString()).toBe('1');
  });
});

describe('rounding direction protects the target (spec §4.3, §4.4)', () => {
  it('rounds effective units DOWN so a quote never overstates delivery', () => {
    // 1.0001 raw area units outside the area = 0.50005 effective, which must
    // not be reported as 0.5001.
    const effective = lookup.effectiveUnits(UnitQuantity.of('area', '1.0001'), 'outside');
    expect(effective.toString()).toBe('0.5000');
  });

  it('rounds required raw units UP so an allocation is never fractionally short', () => {
    // Needing 0.3334 effective units from outside stock requires 0.6668 raw.
    const raw = lookup.rawUnitsRequired(UnitQuantity.of('area', '0.3334'), 'outside');
    expect(raw.toString()).toBe('0.6668');
  });

  it('never round-trips to less than the requested effective units', () => {
    for (const band of ['same-lpa', 'neighbouring-lpa-same-nca', 'outside'] as const) {
      for (let i = 1; i <= 400; i += 1) {
        const wanted = UnitQuantity.of('area', String(i / 7));
        const raw = lookup.rawUnitsRequired(wanted, band);
        const delivered = lookup.effectiveUnits(raw, band);
        expect(
          delivered.greaterThanOrEqual(wanted),
          `${band}: wanted ${wanted} got ${delivered} from raw ${raw}`,
        ).toBe(true);
      }
    }
  });

  it('holds for hedgerow and watercourse at 3dp too', () => {
    for (const module of ['hedgerow', 'watercourse'] as const) {
      for (let i = 1; i <= 200; i += 1) {
        const wanted = UnitQuantity.of(module, String(i / 3));
        const raw = lookup.rawUnitsRequired(wanted, 'neighbouring-lpa-same-nca');
        expect(lookup.effectiveUnits(raw, 'neighbouring-lpa-same-nca').greaterThanOrEqual(wanted)).toBe(true);
      }
    }
  });

  it('leaves same-LPA quantities untouched', () => {
    const q = UnitQuantity.of('area', '2.3457');
    expect(lookup.effectiveUnits(q, 'same-lpa').toString()).toBe('2.3457');
    expect(lookup.rawUnitsRequired(q, 'same-lpa').toString()).toBe('2.3457');
  });

  it('preserves module scale through the conversion', () => {
    expect(lookup.rawUnitsRequired(UnitQuantity.of('hedgerow', '1.0'), 'outside').toString()).toBe('2.000');
    expect(lookup.effectiveUnits(UnitQuantity.of('watercourse', '1.0'), 'outside').toString()).toBe('0.500');
  });
});

describe('buffered target (spec §4.3.4)', () => {
  it('sits fractionally above 10%, not exactly on it', () => {
    const baseline = UnitQuantity.of('area', '100.0');
    const target = bufferedTarget('area', baseline);
    expect(target.toString()).toBe('10.1000');
    expect(target.greaterThan(baseline.times('0.10'))).toBe(true);
  });

  it('rounds the target UP, so the buffer cannot be rounded away', () => {
    const baseline = UnitQuantity.of('area', '3.3333');
    // 3.3333 × 0.101 = 0.33666333 -> must not round down to 0.3366
    expect(bufferedTarget('area', baseline).toString()).toBe('0.3367');
  });

  it('accepts a different confirmed buffer without code changes', () => {
    const baseline = UnitQuantity.of('area', '100.0');
    expect(bufferedTarget('area', baseline, { bufferPercent: '0.5' }).toString()).toBe('10.5000');
    expect(bufferedTarget('area', baseline, { bufferPercent: '0' }).toString()).toBe('10.0000');
  });

  it('applies at each module’s own scale', () => {
    expect(bufferedTarget('hedgerow', UnitQuantity.of('hedgerow', '50.0')).toString()).toBe('5.050');
    expect(bufferedTarget('watercourse', UnitQuantity.of('watercourse', '12.345')).toString()).toBe('1.247');
  });
});
