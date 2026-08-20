import Decimal from 'decimal.js';
import { MONEY_SCALE } from './modules.js';
import { UnitQuantity, type RoundingMode } from './quantity.js';

const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

const DECIMAL_ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  'half-up': Decimal.ROUND_HALF_UP,
  up: Decimal.ROUND_UP,
  down: Decimal.ROUND_DOWN,
};

const MAX_AMOUNT = new D('1e12');

export type MoneyInput = string | number | Decimal | Money;

/**
 * A monetary amount, held at 2 decimal places.
 *
 * This is a deliberately separate system from `UnitQuantity` (§3.3 of the
 * specification): prices are 2dp regardless of module, unit quantities are
 * 3dp or 4dp depending on module, and the two must not be conflated. Keeping
 * them as distinct types means the compiler rejects the conflation rather
 * than it surviving into a quote.
 *
 * The single legitimate crossing point between the two systems is
 * `Money.lineTotal`, which is the only place a price meets a quantity.
 *
 * Currency is GBP throughout — BNG units are a UK statutory market. The
 * currency is carried explicitly anyway so that a future change is a typed
 * error rather than a silent reinterpretation of stored figures.
 */
export class Money {
  readonly currency: 'GBP';
  readonly #amount: Decimal;

  private constructor(amount: Decimal) {
    this.currency = 'GBP';
    this.#amount = amount;
    Object.freeze(this);
  }

  static of(input: MoneyInput, rounding: RoundingMode = 'half-up'): Money {
    if (input instanceof Money) return input;
    const raw = Money.#toDecimal(input);
    return new Money(raw.toDecimalPlaces(MONEY_SCALE, DECIMAL_ROUNDING[rounding]));
  }

  static #toDecimal(input: string | number | Decimal): Decimal {
    let raw: Decimal;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new RangeError(`Monetary amount must be finite, received ${input}.`);
      }
      raw = new D(input.toString());
    } else if (typeof input === 'string') {
      const trimmed = input.trim().replace(/^£/, '').replace(/,/g, '');
      if (trimmed === '') {
        throw new RangeError('Monetary amount cannot be constructed from an empty string.');
      }
      raw = new D(trimmed);
    } else {
      raw = new D(input.toString());
    }

    if (!raw.isFinite()) {
      throw new RangeError(`Monetary amount must be finite, received ${String(input)}.`);
    }
    if (raw.abs().greaterThan(MAX_AMOUNT)) {
      throw new RangeError(`Monetary amount ${raw.toString()} exceeds the maximum supported value.`);
    }
    return raw;
  }

  static parse(input: unknown, rounding: RoundingMode = 'half-up'): Money {
    if (typeof input !== 'string' && typeof input !== 'number' && !(input instanceof Decimal)) {
      throw new TypeError(`Cannot read a monetary amount from ${JSON.stringify(input)}.`);
    }
    if (typeof input === 'string' && !/^\s*£?\s*-?[\d,]+(\.\d*)?\s*$/.test(input)) {
      throw new RangeError(`"${input}" is not a readable monetary amount.`);
    }
    return Money.of(input, rounding);
  }

  static tryParse(input: unknown, rounding: RoundingMode = 'half-up'): Money | null {
    try {
      return Money.parse(input, rounding);
    } catch {
      return null;
    }
  }

  static zero(): Money {
    return new Money(new D(0));
  }

  /**
   * The one sanctioned crossing point between the money and unit-quantity
   * systems: a line total is a unit price multiplied by a quantity.
   *
   * The multiplication is carried out at full precision and rounded to 2dp
   * exactly once, at the end — so a 4dp quantity against a 2dp price gives the
   * correct penny rather than one distorted by an intermediate rounding.
   */
  static lineTotal(unitPrice: Money, quantity: UnitQuantity): Money {
    const product = unitPrice.#amount.times(quantity.toDecimal());
    return new Money(product.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP));
  }

  plus(other: Money): Money {
    return new Money(this.#amount.plus(other.#amount));
  }

  minus(other: Money): Money {
    return new Money(this.#amount.minus(other.#amount));
  }

  times(factor: string | number | Decimal, rounding: RoundingMode = 'half-up'): Money {
    const product = this.#amount.times(Money.#toDecimal(factor));
    return new Money(product.toDecimalPlaces(MONEY_SCALE, DECIMAL_ROUNDING[rounding]));
  }

  /** Sum a list of amounts. Exact — 2dp addition introduces no rounding. */
  static sum(amounts: readonly Money[]): Money {
    return amounts.reduce<Money>((acc, m) => acc.plus(m), Money.zero());
  }

  isZero(): boolean {
    return this.#amount.isZero();
  }

  isNegative(): boolean {
    return this.#amount.isNegative() && !this.#amount.isZero();
  }

  equals(other: Money): boolean {
    return this.#amount.equals(other.#amount);
  }

  lessThan(other: Money): boolean {
    return this.#amount.lessThan(other.#amount);
  }

  greaterThan(other: Money): boolean {
    return this.#amount.greaterThan(other.#amount);
  }

  toDecimal(): Decimal {
    return new D(this.#amount);
  }

  /** Canonical storage/serialisation form: always 2dp, never exponential. */
  toString(): string {
    return this.#amount.toFixed(MONEY_SCALE);
  }

  toJSON(): string {
    return this.toString();
  }

  /** Formatted for display and for quote documents, e.g. "£1,234.50". */
  format(): string {
    const negative = this.isNegative();
    const [whole = '0', fraction = '00'] = this.#amount.abs().toFixed(MONEY_SCALE).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${negative ? '-' : ''}£${grouped}.${fraction}`;
  }

  toUnsafeNumber(): number {
    return this.#amount.toNumber();
  }
}
