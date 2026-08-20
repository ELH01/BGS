import Decimal from 'decimal.js';
import { Money } from '@bgs/core';

/**
 * VAT treatment of a quote.
 *
 * §5.7 of the specification lists this as an open question: whether unit sales
 * are standard-rated, and whether the operator is VAT registered, decide
 * whether a quote needs a subtotal/VAT/total breakdown or a single figure.
 *
 * Rather than guess, the treatment is configuration. `none` produces the flat
 * total the platform has used all along, and is the default. `standard-rate`
 * adds the breakdown. Nothing about the stored line data changes either way —
 * a quote priced today still renders correctly if the treatment changes
 * tomorrow, because VAT is applied at render time from the stored net figures.
 */
export type VatTreatment = 'none' | 'standard-rate';

export interface VatConfig {
  treatment: VatTreatment;
  /** Percentage, as an exact decimal string. Only read for `standard-rate`. */
  ratePercent: string;
  /** Shown on the document, e.g. "GB123456789". */
  registrationNumber?: string | undefined;
  /**
   * Whether this has been confirmed with the operator. Unconfirmed treatments
   * are marked on the document, so a quote never implies a VAT position
   * nobody has verified.
   */
  status: 'unconfirmed' | 'confirmed';
}

export const DEFAULT_VAT_CONFIG: VatConfig = Object.freeze({
  treatment: 'none',
  ratePercent: '20',
  status: 'unconfirmed',
});

export interface QuoteTotals {
  /** Sum of the line totals, before any VAT. */
  net: Money;
  /** Null when no VAT is applied. */
  vat: Money | null;
  /** Net plus VAT, or simply net when no VAT is applied. */
  gross: Money;
}

/**
 * Work out the figures a quote document shows.
 *
 * VAT is computed on the net total rather than per line, and rounded once, so
 * the document's arithmetic adds up on the page.
 */
export function quoteTotals(lineTotals: readonly Money[], config: VatConfig = DEFAULT_VAT_CONFIG): QuoteTotals {
  const net = Money.sum(lineTotals);

  if (config.treatment === 'none') {
    return { net, vat: null, gross: net };
  }

  const rate = new Decimal(config.ratePercent);
  if (!rate.isFinite() || rate.isNegative() || rate.greaterThan(100)) {
    throw new RangeError(`VAT rate must be between 0 and 100, received ${config.ratePercent}.`);
  }

  const vat = net.times(rate.dividedBy(100));
  return { net, vat, gross: net.plus(vat) };
}
