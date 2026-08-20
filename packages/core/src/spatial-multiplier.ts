import Decimal from 'decimal.js';
import type { MetricModule } from './modules.js';
import { UnitQuantity } from './quantity.js';

/**
 * Spatial risk bands under the current (LPA/NCA-based) methodology.
 *
 * DEFRA has signalled a future move of this methodology onto Local Nature
 * Recovery Strategy boundaries, with no confirmed date as of mid-2026. That is
 * why this file defines a *scheme* rather than a fixed lookup: an LNRS scheme
 * can be added alongside the current one and selected per site, without the
 * allocation solver changing at all.
 */
export const LPA_NCA_BANDS = ['same-lpa', 'neighbouring-lpa-same-nca', 'outside'] as const;

export type LpaNcaBand = (typeof LPA_NCA_BANDS)[number];

export const LPA_NCA_BAND_LABEL: Readonly<Record<LpaNcaBand, string>> = Object.freeze({
  'same-lpa': 'Same LPA as the development',
  'neighbouring-lpa-same-nca': 'Neighbouring LPA, same NCA',
  outside: 'Outside the development’s LPA and NCA',
});

/**
 * Whether a scheme's values have been confirmed by the operator against a
 * current authoritative source.
 *
 * The specification is explicit that these values must not be hardcoded from
 * an unverified source. Rather than block the build on it, an unconfirmed
 * scheme is usable — so the solver and exports can be developed and tested —
 * but every calculation derived from it is marked, and the UI and quote
 * exports surface that marking. Nothing unconfirmed can silently pass itself
 * off as authoritative.
 */
export type SchemeStatus = 'unconfirmed' | 'confirmed';

export interface SpatialRiskScheme {
  readonly id: string;
  readonly label: string;
  readonly status: SchemeStatus;
  /** Where the values came from, and who confirmed them. Rendered in the UI. */
  readonly source: string;
  readonly confirmedBy?: string;
  readonly confirmedOn?: string;
  /**
   * The delivery factor per band, as an exact decimal string.
   *
   * Semantics, stated once so it cannot be misread: this is the factor that
   * *raw* units from a parcel are multiplied by to give the *effective* units
   * they deliver toward a development's shortfall. It is at most 1.0, and
   * falls as the bank gets further from the development.
   *
   *   effective = raw × factor
   *   raw needed = effective ÷ factor   (see `rawUnitsRequired`)
   *
   * The specification phrases the multiplier the other way round — "how many
   * raw units are needed to deliver one effective unit", which is 1/factor.
   * Both readings are available via `deliveryFactor` and `rawUnitsPerEffectiveUnit`;
   * the factor is what is stored, because that is the direction the DEFRA
   * metric itself uses and therefore the direction Elliott's reference values
   * will arrive in.
   */
  readonly factors: Readonly<Record<LpaNcaBand, string>>;
}

/**
 * PLACEHOLDER VALUES — NOT CONFIRMED. See §5.3 of the build specification.
 *
 * These are the figures commonly cited for the current metric, included so the
 * solver, exposure dashboard and exports can be built and tested end to end.
 * They are deliberately marked `unconfirmed`, and must be replaced with values
 * Elliott has verified against a current authoritative source before this
 * platform is used to produce a real quote.
 *
 * Do not remove the `unconfirmed` status by editing this constant — supply a
 * confirmed scheme through configuration instead, so that the provenance and
 * the confirming person are recorded.
 */
export const PLACEHOLDER_LPA_NCA_SCHEME: SpatialRiskScheme = Object.freeze({
  id: 'lpa-nca-placeholder',
  label: 'LPA/NCA spatial risk (placeholder — unconfirmed)',
  status: 'unconfirmed',
  source:
    'Placeholder values pending confirmation against a current authoritative source. Not to be relied on for a real quote.',
  factors: Object.freeze({
    'same-lpa': '1.00',
    'neighbouring-lpa-same-nca': '0.75',
    outside: '0.50',
  }),
});

export class SpatialRiskLookup {
  readonly scheme: SpatialRiskScheme;

  constructor(scheme: SpatialRiskScheme = PLACEHOLDER_LPA_NCA_SCHEME) {
    for (const band of LPA_NCA_BANDS) {
      const raw = scheme.factors[band];
      const value = new Decimal(raw);
      if (!value.isFinite() || value.lessThanOrEqualTo(0) || value.greaterThan(1)) {
        throw new RangeError(
          `Spatial risk factor for "${band}" must be greater than 0 and at most 1, received ${raw}.`,
        );
      }
    }
    this.scheme = scheme;
  }

  get isConfirmed(): boolean {
    return this.scheme.status === 'confirmed';
  }

  /**
   * Which band a bank site falls into relative to a development site.
   *
   * Comparison is on identifier equality, so callers must pass canonical LPA
   * and NCA identifiers rather than free text. Neighbour relationships are
   * supplied by the caller because LPA adjacency is reference data, not
   * something this function can derive.
   */
  static classify(input: {
    bankLpa: string;
    bankNca: string;
    developmentLpa: string;
    developmentNca: string;
    /** LPA identifiers adjacent to the development's LPA. */
    neighbouringLpas?: readonly string[];
  }): LpaNcaBand {
    const { bankLpa, bankNca, developmentLpa, developmentNca, neighbouringLpas = [] } = input;

    if (bankLpa === developmentLpa) return 'same-lpa';
    if (neighbouringLpas.includes(bankLpa) && bankNca === developmentNca) {
      return 'neighbouring-lpa-same-nca';
    }
    return 'outside';
  }

  /** Factor that raw units are multiplied by to give effective units. */
  deliveryFactor(band: LpaNcaBand): Decimal {
    return new Decimal(this.scheme.factors[band]);
  }

  /**
   * The specification's reading of the multiplier: how many raw units from a
   * parcel in this band are needed to deliver one effective unit.
   */
  rawUnitsPerEffectiveUnit(band: LpaNcaBand): Decimal {
    return new Decimal(1).dividedBy(this.deliveryFactor(band));
  }

  /**
   * Effective units delivered toward a shortfall by drawing `raw` from a
   * parcel in this band.
   *
   * Rounded DOWN: claiming more effective units than the arithmetic strictly
   * supports could put a quote fractionally under its target, which is the one
   * failure mode this whole export exists to prevent.
   */
  effectiveUnits(raw: UnitQuantity, band: LpaNcaBand): UnitQuantity {
    return raw.times(this.deliveryFactor(band), 'down');
  }

  /**
   * Raw units that must be drawn from a parcel in this band to deliver
   * `effective` units toward a shortfall.
   *
   * Rounded UP, for the same reason: rounding this figure down would allocate
   * fractionally too little stock and leave the quote short of its target.
   */
  rawUnitsRequired(effective: UnitQuantity, band: LpaNcaBand): UnitQuantity {
    return effective.dividedBy(this.deliveryFactor(band), 'up');
  }
}

/**
 * The buffer applied above the statutory 10% net gain, per §4.3.4.
 *
 * A quote solved to exactly 10.00% can fall below 10% when the figures are
 * re-rounded during the LPA's review, which would invalidate it. The buffer
 * lifts the target just above the line so that re-rounding cannot take it
 * under. The default is a suggestion pending Elliott's confirmation (§5.4).
 */
export const DEFAULT_NET_GAIN_BUFFER_PERCENT = '0.1';
export const STATUTORY_NET_GAIN_PERCENT = '10';

/**
 * The effective units a module's allocation must reach.
 *
 * Rounded UP to the module's scale: the target is a floor that must be
 * cleared, so rounding it down would defeat the buffer's whole purpose.
 */
export function bufferedTarget(
  module: MetricModule,
  baselineUnits: UnitQuantity,
  options: { gainPercent?: string; bufferPercent?: string } = {},
): UnitQuantity {
  const gain = new Decimal(options.gainPercent ?? STATUTORY_NET_GAIN_PERCENT);
  const buffer = new Decimal(options.bufferPercent ?? DEFAULT_NET_GAIN_BUFFER_PERCENT);
  const proportion = gain.plus(buffer).dividedBy(100);
  return baselineUnits.times(proportion, 'up');
}
