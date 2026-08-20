import { describe, expect, it } from 'vitest';
import { MODULE_SCALE, METRIC_MODULES, type MetricModule } from './modules.js';
import { UnitQuantity } from './quantity.js';

describe('UnitQuantity precision (spec §2)', () => {
  it('holds area units at 4 decimal places', () => {
    expect(UnitQuantity.of('area', '2.3').toString()).toBe('2.3000');
    expect(UnitQuantity.of('area', '2.34567').toString()).toBe('2.3457');
  });

  it('holds hedgerow and watercourse units at 3 decimal places', () => {
    expect(UnitQuantity.of('hedgerow', '2.3').toString()).toBe('2.300');
    expect(UnitQuantity.of('watercourse', '2.34567').toString()).toBe('2.346');
  });

  it.each(METRIC_MODULES)('renders %s at exactly its scale, never exponential', (module) => {
    const tiny = UnitQuantity.of(module, '0.0001');
    expect(tiny.toString()).not.toMatch(/e/i);
    expect(tiny.toString().split('.')[1]).toHaveLength(MODULE_SCALE[module]);

    const large = UnitQuantity.of(module, '123456789');
    expect(large.toString()).not.toMatch(/e/i);
  });

  it('rounds at construction, so stored values are already canonical', () => {
    // Not merely a display concern: the rounded value is what participates in
    // all later arithmetic.
    const q = UnitQuantity.of('hedgerow', '1.9999');
    expect(q.toString()).toBe('2.000');
    expect(q.toDecimal().toString()).toBe('2');
  });

  it('never introduces IEEE floating point error', () => {
    const a = UnitQuantity.of('area', 0.1);
    const b = UnitQuantity.of('area', 0.2);
    expect(a.plus(b).toString()).toBe('0.3000');
    // The float trap this exists to avoid:
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('reads a numeric literal as its decimal value, not the nearest double', () => {
    expect(UnitQuantity.of('area', 1.005).toString()).toBe('1.0050');
    expect(UnitQuantity.of('area', 0.1).toDecimal().toString()).toBe('0.1');
  });
});

describe('UnitQuantity module separation (spec §4.3)', () => {
  it('refuses to add quantities from different modules', () => {
    const area = UnitQuantity.of('area', '1.0');
    const hedge = UnitQuantity.of('hedgerow', '1.0');
    expect(() => area.plus(hedge)).toThrow(/never be blended/);
    expect(() => area.minus(hedge)).toThrow(/never be blended/);
  });

  it('refuses to compare quantities from different modules', () => {
    const area = UnitQuantity.of('area', '1.0');
    const water = UnitQuantity.of('watercourse', '1.0');
    expect(() => area.lessThan(water)).toThrow(/never be blended/);
  });

  it('refuses to reinterpret one module as another', () => {
    const hedge = UnitQuantity.of('hedgerow', '1.0');
    expect(() => UnitQuantity.of('area', hedge)).toThrow(/not interchangeable/);
  });

  it('treats equal magnitudes in different modules as unequal', () => {
    expect(UnitQuantity.of('hedgerow', '1.0').equals(UnitQuantity.of('watercourse', '1.0'))).toBe(false);
  });
});

describe('UnitQuantity drift (spec §2: repeated operations must not accumulate drift)', () => {
  it.each(METRIC_MODULES)('%s: 10,000 allocate/retire cycles return exactly to the start', (module) => {
    const start = UnitQuantity.of(module, '5.0');
    const draw = UnitQuantity.of(module, '0.3');

    let pool = start;
    for (let i = 0; i < 10_000; i += 1) {
      pool = pool.minus(draw).plus(draw);
    }
    expect(pool.toString()).toBe(start.toString());
  });

  it.each(METRIC_MODULES)('%s: many small allocations sum back to the whole exactly', (module) => {
    const scale = MODULE_SCALE[module];
    const smallest = UnitQuantity.of(module, `0.${'0'.repeat(scale - 1)}1`);

    let pool = UnitQuantity.zero(module);
    for (let i = 0; i < 5_000; i += 1) {
      pool = pool.plus(smallest);
    }
    // 5000 × the smallest representable step, exactly.
    const expected = smallest.times(5_000);
    expect(pool.equals(expected)).toBe(true);
  });

  it('partial retirement is precision-preserving (spec §4.6)', () => {
    // The specification's own worked example.
    const parcel = UnitQuantity.of('area', '5.0');
    const allocation = UnitQuantity.of('area', '2.3');
    expect(parcel.minus(allocation).toString()).toBe('2.7000');
  });

  it('a reversed sale restores the pool to its exact prior figure (spec §4.6)', () => {
    const before = UnitQuantity.of('area', '13.7421');
    const retired = UnitQuantity.of('area', '4.9999');
    const after = before.minus(retired);
    expect(after.toString()).toBe('8.7422');
    expect(after.plus(retired).equals(before)).toBe(true);
  });
});

describe('UnitQuantity rounding direction', () => {
  it('defaults to half-up', () => {
    expect(UnitQuantity.of('hedgerow', '1.2345').toString()).toBe('1.235');
    expect(UnitQuantity.of('hedgerow', '1.2344').toString()).toBe('1.234');
  });

  it('rounds up when the caller needs at-least-this-much', () => {
    expect(UnitQuantity.of('hedgerow', '1.2341', 'up').toString()).toBe('1.235');
    expect(UnitQuantity.of('area', '1.00001', 'up').toString()).toBe('1.0001');
  });

  it('rounds down when the caller needs at-most-this-much', () => {
    expect(UnitQuantity.of('hedgerow', '1.2349', 'down').toString()).toBe('1.234');
  });

  it('rounds toward zero, not toward negative infinity, when rounding down', () => {
    expect(UnitQuantity.of('hedgerow', '-1.2349', 'down').toString()).toBe('-1.234');
    expect(UnitQuantity.of('hedgerow', '-1.2341', 'up').toString()).toBe('-1.235');
  });

  it('propagates the direction through scaling', () => {
    const q = UnitQuantity.of('area', '1.0');
    expect(q.times('0.333333', 'up').toString()).toBe('0.3334');
    expect(q.times('0.333333', 'down').toString()).toBe('0.3333');
  });
});

describe('UnitQuantity input validation', () => {
  it('rejects non-finite input', () => {
    expect(() => UnitQuantity.of('area', Number.NaN)).toThrow(/finite/);
    expect(() => UnitQuantity.of('area', Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('rejects implausible magnitudes that indicate a misread workbook cell', () => {
    expect(() => UnitQuantity.of('area', '1e10')).toThrow(/maximum supported magnitude/);
  });

  it('rejects text that is not a plain decimal', () => {
    expect(() => UnitQuantity.parse('area', '2.3 units')).toThrow(/not a plain decimal/);
    expect(() => UnitQuantity.parse('area', 'N/A')).toThrow(/not a plain decimal/);
    expect(() => UnitQuantity.parse('area', '1e5')).toThrow(/not a plain decimal/);
    expect(() => UnitQuantity.parse('area', null)).toThrow(/Cannot read/);
  });

  it('tryParse surfaces unreadable cells as null rather than throwing (spec §4.1)', () => {
    expect(UnitQuantity.tryParse('area', 'see note')).toBeNull();
    expect(UnitQuantity.tryParse('area', '')).toBeNull();
    expect(UnitQuantity.tryParse('area', '2.3')?.toString()).toBe('2.3000');
  });

  it('accepts surrounding whitespace from workbook cells', () => {
    expect(UnitQuantity.parse('area', '  2.3  ').toString()).toBe('2.3000');
  });

  it('refuses division by zero', () => {
    expect(() => UnitQuantity.of('area', '1.0').dividedBy(0)).toThrow(/divide .* by zero/);
  });
});

describe('UnitQuantity helpers', () => {
  it('sums a list exactly', () => {
    const qs = ['1.1111', '2.2222', '3.3333'].map((v) => UnitQuantity.of('area', v));
    expect(UnitQuantity.sum('area', qs).toString()).toBe('6.6666');
  });

  it('sums an empty list to zero', () => {
    expect(UnitQuantity.sum('watercourse', []).toString()).toBe('0.000');
  });

  it('serialises to JSON as a string, never a number', () => {
    const q = UnitQuantity.of('area', '2.5');
    expect(JSON.stringify({ q })).toBe('{"q":"2.5000"}');
  });

  it('reports sign correctly, treating zero as neither positive nor negative', () => {
    const zero = UnitQuantity.zero('area');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  it('exposes min and max', () => {
    const a = UnitQuantity.of('area', '1.0');
    const b = UnitQuantity.of('area', '2.0');
    expect(UnitQuantity.min(a, b).equals(a)).toBe(true);
    expect(UnitQuantity.max(a, b).equals(b)).toBe(true);
  });

  it('is immutable', () => {
    const q = UnitQuantity.of('area', '1.0');
    q.plus(UnitQuantity.of('area', '5.0'));
    expect(q.toString()).toBe('1.0000');
    expect(Object.isFrozen(q)).toBe(true);
  });
});

describe('module scale table', () => {
  it('matches the specification exactly', () => {
    const expected: Record<MetricModule, number> = { area: 4, hedgerow: 3, watercourse: 3 };
    expect(MODULE_SCALE).toEqual(expected);
  });
});
