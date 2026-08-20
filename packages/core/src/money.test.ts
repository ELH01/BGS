import { describe, expect, it } from 'vitest';
import { Money } from './money.js';
import { UnitQuantity } from './quantity.js';

describe('Money precision', () => {
  it('holds amounts at 2 decimal places', () => {
    expect(Money.of('1200').toString()).toBe('1200.00');
    expect(Money.of('1200.456').toString()).toBe('1200.46');
  });

  it('never introduces floating point error', () => {
    expect(Money.of('0.1').plus(Money.of('0.2')).toString()).toBe('0.30');
  });

  it('sums exactly over many additions', () => {
    let total = Money.zero();
    for (let i = 0; i < 10_000; i += 1) total = total.plus(Money.of('0.01'));
    expect(total.toString()).toBe('100.00');
  });

  it('reads prices typed with a currency symbol or thousands separators', () => {
    expect(Money.parse('£12,500.50').toString()).toBe('12500.50');
    expect(Money.parse('12,500').toString()).toBe('12500.00');
  });

  it('rejects unreadable prices', () => {
    expect(() => Money.parse('POA')).toThrow(/not a readable monetary amount/);
    expect(Money.tryParse('POA')).toBeNull();
  });

  it('formats for display and for quote documents', () => {
    expect(Money.of('1234.5').format()).toBe('£1,234.50');
    expect(Money.of('999').format()).toBe('£999.00');
    expect(Money.of('1234567.89').format()).toBe('£1,234,567.89');
    expect(Money.of('-50').format()).toBe('-£50.00');
    expect(Money.zero().format()).toBe('£0.00');
  });

  it('serialises as a string, never a JSON number', () => {
    expect(JSON.stringify({ price: Money.of('25.5') })).toBe('{"price":"25.50"}');
  });
});

describe('Money is a separate precision system from UnitQuantity (spec §3.3)', () => {
  it('keeps price at 2dp even for a 4dp module', () => {
    const price = Money.of('12500.4567');
    expect(price.toString()).toBe('12500.46');
  });

  it('computes a line total by rounding once, at the end', () => {
    // 2.3457 area units at £12,500.00 — the multiplication is carried at full
    // precision and rounded to pence exactly once.
    const qty = UnitQuantity.of('area', '2.34567');
    const price = Money.of('12500');
    expect(qty.toString()).toBe('2.3457');
    expect(Money.lineTotal(price, qty).toString()).toBe('29321.25');
  });

  it('does not let the quantity scale bleed into the price scale', () => {
    const qty = UnitQuantity.of('hedgerow', '1.333');
    const price = Money.of('999.99');
    const total = Money.lineTotal(price, qty);
    // 1.333 × 999.99 = 1332.98667 -> 1332.99
    expect(total.toString()).toBe('1332.99');
  });

  it('a quote total is the exact sum of its line totals (spec §3.7)', () => {
    const lines = [
      Money.lineTotal(Money.of('12500'), UnitQuantity.of('area', '2.3457')),
      Money.lineTotal(Money.of('8000'), UnitQuantity.of('area', '1.1111')),
      Money.lineTotal(Money.of('15000'), UnitQuantity.of('area', '0.5')),
    ];
    expect(Money.sum(lines).toString()).toBe('45710.05');
    expect(lines.map((l) => l.toString())).toEqual(['29321.25', '8888.80', '7500.00']);
  });

  it('has no operation that accepts a UnitQuantity except lineTotal', () => {
    // Guards the §3.3 requirement that the two systems are not conflated: the
    // only sanctioned crossing point is the named static.
    const qty = UnitQuantity.of('area', '2.0') as unknown as Money;
    expect(() => Money.of('10').plus(qty)).toThrow();
  });
});
