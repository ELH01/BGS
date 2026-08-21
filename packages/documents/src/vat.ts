import Decimal from 'decimal.js';
import { Money } from '@bgs/core';

/**
 * VAT treatment of a quote.
 *
 * Quotes show the total excluding VAT, the VAT itself, and the total
 * including VAT — so a purchaser can see both the figure their finance team
 * will book and the figure they will actually pay.
 *
 * `standard-rate` is the default. `none` remains available for the case where
 * the operator is not VAT registered, and prints a single total with a line
 * saying no VAT is charged, rather than leaving the reader to wonder whether
 * it was forgotten.
 *
 * The treatment is applied at render time from the stored net figures, so
 * nothing about a quote priced today has to change if the position is settled
 * differently tomorrow.
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
  treatment: 'standard-rate',
  ratePercent: '20',
  status: 'unconfirmed',
});

/**
 * A percentage as someone would write it.
 *
 * The rate is stored as a numeric with room for fractions of a per cent, so it
 * arrives as "20.000". Printing that on a quote reads like a spreadsheet
 * artefact rather than a rate, so trailing zeros are dropped — while a genuine
 * fractional rate such as 12.5% keeps its digits.
 */
export function formatRatePercent(rate: string): string {
  const trimmed = rate.trim();
  if (!trimmed.includes('.')) return trimmed;
  return trimmed.replace(/0+$/, '').replace(/\.$/, '');
}

export interface QuoteTotals {
  /** Sum of the line totals. The total excluding VAT. */
  net: Money;
  /** The VAT itself. Zero, not null, when none is charged — see below. */
  vat: Money;
  /** Net plus VAT. The total including VAT. */
  gross: Money;
  /** Whether VAT is actually being charged, for wording the document. */
  vatCharged: boolean;
  /** The rate applied, for the VAT line's label. */
  ratePercent: string;
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
    // Zero rather than null, so a document always has all three figures to
    // print and the reader can see VAT was considered rather than omitted.
    return { net, vat: Money.zero(), gross: net, vatCharged: false, ratePercent: '0' };
  }

  const rate = new Decimal(config.ratePercent);
  if (!rate.isFinite() || rate.isNegative() || rate.greaterThan(100)) {
    throw new RangeError(`VAT rate must be between 0 and 100, received ${config.ratePercent}.`);
  }

  const vat = net.times(rate.dividedBy(100));
  return {
    net,
    vat,
    gross: net.plus(vat),
    vatCharged: true,
    ratePercent: formatRatePercent(config.ratePercent),
  };
}
