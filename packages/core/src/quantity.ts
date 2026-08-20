import Decimal from 'decimal.js';
import { MODULE_SCALE, type MetricModule } from './modules.js';

/**
 * A private Decimal constructor so that configuring precision here can never
 * disturb another library's use of decimal.js in the same process.
 *
 * `toExpNeg`/`toExpPos` are pushed out of range so that `toFixed` and
 * `toString` never fall back to exponential notation — a unit quantity that
 * renders as "1e-4" in an exported metric workbook would be a defect.
 */
const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

/**
 * Rounding direction, for the places where the direction is load-bearing
 * rather than incidental.
 *
 * `half-up` is the default and is what parcel totals, allocation quantities
 * and retirements use. `up`/`down` exist for the conversions where rounding
 * the wrong way changes whether a regulatory target is met — see
 * `rawUnitsRequired` in ./spatial-multiplier.ts, which must never round down.
 */
export type RoundingMode = 'half-up' | 'up' | 'down';

const DECIMAL_ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  'half-up': Decimal.ROUND_HALF_UP,
  up: Decimal.ROUND_UP,
  down: Decimal.ROUND_DOWN,
};

/**
 * Largest magnitude a unit quantity may take. Habitat bank parcels are
 * measured in tens or hundreds of units; anything beyond this is a parsing
 * error in a source workbook rather than a real figure, and is better caught
 * at the boundary than stored.
 */
const MAX_MAGNITUDE = new D('1e9');

export type QuantityInput = string | number | Decimal | UnitQuantity;

/**
 * A biodiversity unit quantity, held at exactly the decimal precision its
 * module requires (§2 of the build specification).
 *
 * Two properties make this type worth having over a bare number:
 *
 *  1. **It is never an IEEE float.** Values arrive from workbooks as strings
 *     and are held as arbitrary-precision decimals throughout, so `0.1 + 0.2`
 *     problems cannot arise in stock arithmetic.
 *
 *  2. **Every instance is already canonical.** Rounding happens once, at
 *     construction, to the module's scale. Because addition and subtraction of
 *     two values at scale N are exact at scale N, repeated
 *     allocate/retire/restore cycles cannot accumulate drift — there is no
 *     residue below the scale for drift to accumulate from. Multiplication and
 *     division are the only operations that can introduce rounding, and both
 *     make that explicit in their signature.
 *
 * Instances are immutable; every operation returns a new instance.
 */
export class UnitQuantity {
  readonly module: MetricModule;
  readonly #value: Decimal;

  private constructor(module: MetricModule, value: Decimal) {
    this.module = module;
    this.#value = value;
    Object.freeze(this);
  }

  /** Decimal places this quantity is held at, determined by its module. */
  get scale(): number {
    return MODULE_SCALE[this.module];
  }

  /**
   * Construct a quantity for `module`, rounding to that module's scale.
   *
   * Numbers are accepted for ergonomics in tests and UI input, but are routed
   * through their decimal string form so that a literal such as `0.1` means
   * one tenth rather than the nearest double to one tenth.
   */
  static of(module: MetricModule, input: QuantityInput, rounding: RoundingMode = 'half-up'): UnitQuantity {
    if (input instanceof UnitQuantity) {
      if (input.module !== module) {
        throw new TypeError(
          `Cannot reinterpret a ${input.module} quantity as ${module}; modules are not interchangeable.`,
        );
      }
      return input;
    }

    const raw = UnitQuantity.#toDecimal(input);
    const scaled = raw.toDecimalPlaces(MODULE_SCALE[module], DECIMAL_ROUNDING[rounding]);
    return new UnitQuantity(module, scaled);
  }

  static #toDecimal(input: string | number | Decimal): Decimal {
    let raw: Decimal;

    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new RangeError(`Unit quantity must be a finite number, received ${input}.`);
      }
      // Via the shortest decimal string that round-trips, so 0.1 is one tenth.
      raw = new D(input.toString());
    } else if (typeof input === 'string') {
      const trimmed = input.trim();
      if (trimmed === '') {
        throw new RangeError('Unit quantity cannot be constructed from an empty string.');
      }
      raw = new D(trimmed);
    } else {
      raw = new D(input.toString());
    }

    if (!raw.isFinite()) {
      throw new RangeError(`Unit quantity must be finite, received ${String(input)}.`);
    }
    if (raw.abs().greaterThan(MAX_MAGNITUDE)) {
      throw new RangeError(
        `Unit quantity ${raw.toString()} exceeds the maximum supported magnitude; this usually indicates a misread cell in a source workbook.`,
      );
    }
    return raw;
  }

  /** Parse a quantity from untrusted text (workbook cell, form field). */
  static parse(module: MetricModule, input: unknown, rounding: RoundingMode = 'half-up'): UnitQuantity {
    if (typeof input !== 'string' && typeof input !== 'number' && !(input instanceof Decimal)) {
      throw new TypeError(`Cannot read a unit quantity from ${JSON.stringify(input)}.`);
    }
    if (typeof input === 'string' && !/^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(input)) {
      throw new RangeError(`"${input}" is not a plain decimal number.`);
    }
    return UnitQuantity.of(module, input, rounding);
  }

  /**
   * Parse, returning `null` rather than throwing on unreadable input.
   * Used by workbook parsing, where the specification requires surfacing bad
   * cells to the user for correction rather than failing the whole import.
   */
  static tryParse(module: MetricModule, input: unknown, rounding: RoundingMode = 'half-up'): UnitQuantity | null {
    try {
      return UnitQuantity.parse(module, input, rounding);
    } catch {
      return null;
    }
  }

  static zero(module: MetricModule): UnitQuantity {
    return new UnitQuantity(module, new D(0));
  }

  #sameModule(other: UnitQuantity, operation: string): void {
    if (other.module !== this.module) {
      throw new TypeError(
        `Cannot ${operation} a ${other.module} quantity and a ${this.module} quantity; the three metric modules are separate problems and must never be blended.`,
      );
    }
  }

  /** Exact at the shared scale — no rounding occurs. */
  plus(other: UnitQuantity): UnitQuantity {
    this.#sameModule(other, 'add');
    return new UnitQuantity(this.module, this.#value.plus(other.#value));
  }

  /** Exact at the shared scale — no rounding occurs. */
  minus(other: UnitQuantity): UnitQuantity {
    this.#sameModule(other, 'subtract');
    return new UnitQuantity(this.module, this.#value.minus(other.#value));
  }

  /**
   * Scale by a dimensionless factor (a percentage split, a multiplier).
   * Rounds to the module's scale; the direction is explicit because callers
   * meeting a regulatory target care which way it goes.
   */
  times(factor: string | number | Decimal, rounding: RoundingMode = 'half-up'): UnitQuantity {
    const product = this.#value.times(UnitQuantity.#toDecimal(factor));
    return UnitQuantity.of(this.module, product, rounding);
  }

  /** Divide by a dimensionless factor. Rounds to the module's scale. */
  dividedBy(divisor: string | number | Decimal, rounding: RoundingMode = 'half-up'): UnitQuantity {
    const d = UnitQuantity.#toDecimal(divisor);
    if (d.isZero()) {
      throw new RangeError('Cannot divide a unit quantity by zero.');
    }
    return UnitQuantity.of(this.module, this.#value.dividedBy(d), rounding);
  }

  /** This quantity as a proportion of `whole`, as an exact ratio. */
  ratioTo(whole: UnitQuantity): Decimal {
    this.#sameModule(whole, 'compare');
    if (whole.#value.isZero()) {
      throw new RangeError('Cannot express a quantity as a proportion of zero.');
    }
    return this.#value.dividedBy(whole.#value);
  }

  negated(): UnitQuantity {
    return new UnitQuantity(this.module, this.#value.negated());
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isNegative(): boolean {
    return this.#value.isNegative() && !this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.isPositive() && !this.#value.isZero();
  }

  equals(other: UnitQuantity): boolean {
    return this.module === other.module && this.#value.equals(other.#value);
  }

  lessThan(other: UnitQuantity): boolean {
    this.#sameModule(other, 'compare');
    return this.#value.lessThan(other.#value);
  }

  lessThanOrEqual(other: UnitQuantity): boolean {
    this.#sameModule(other, 'compare');
    return this.#value.lessThanOrEqualTo(other.#value);
  }

  greaterThan(other: UnitQuantity): boolean {
    this.#sameModule(other, 'compare');
    return this.#value.greaterThan(other.#value);
  }

  greaterThanOrEqual(other: UnitQuantity): boolean {
    this.#sameModule(other, 'compare');
    return this.#value.greaterThanOrEqualTo(other.#value);
  }

  static min(a: UnitQuantity, b: UnitQuantity): UnitQuantity {
    return a.lessThanOrEqual(b) ? a : b;
  }

  static max(a: UnitQuantity, b: UnitQuantity): UnitQuantity {
    return a.greaterThanOrEqual(b) ? a : b;
  }

  /** Sum a list. Exact — addition at a shared scale introduces no rounding. */
  static sum(module: MetricModule, quantities: readonly UnitQuantity[]): UnitQuantity {
    return quantities.reduce<UnitQuantity>((acc, q) => acc.plus(q), UnitQuantity.zero(module));
  }

  /** Underlying decimal, for callers that need to compose further arithmetic. */
  toDecimal(): Decimal {
    return new D(this.#value);
  }

  /**
   * The canonical string form: always exactly the module's decimal places,
   * never exponential. This is what is written to the database and rendered
   * into exports, so that a 4dp area figure reads "2.3000" and not "2.3".
   */
  toString(): string {
    return this.#value.toFixed(MODULE_SCALE[this.module]);
  }

  /** Serialised as its canonical string, never as a JSON number. */
  toJSON(): string {
    return this.toString();
  }

  /**
   * Lossy conversion to a float. Deliberately named to be conspicuous in
   * review: it is only ever appropriate for charting or a display-only
   * calculation, never for anything that is stored or compared.
   */
  toUnsafeNumber(): number {
    return this.#value.toNumber();
  }
}
