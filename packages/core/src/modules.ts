/**
 * The three DEFRA biodiversity metric modules.
 *
 * These are deliberately kept as three separate problems throughout the
 * codebase: a hedgerow shortfall can only ever be met with hedgerow stock, a
 * watercourse shortfall only with watercourse stock, and their headline
 * percentage figures are reported independently. Nothing in this codebase
 * should ever sum across modules.
 */
export const METRIC_MODULES = ['area', 'hedgerow', 'watercourse'] as const;

export type MetricModule = (typeof METRIC_MODULES)[number];

/**
 * Decimal places that each module's unit quantities are held at.
 *
 * This is the storage precision, not merely a display convention: quantities
 * are rounded to this scale at the point they are constructed, so every value
 * in the system is already canonical. See `UnitQuantity`.
 */
export const MODULE_SCALE: Readonly<Record<MetricModule, number>> = Object.freeze({
  area: 4,
  hedgerow: 3,
  watercourse: 3,
});

/** Human-readable module names, for UI and exported documents. */
export const MODULE_LABEL: Readonly<Record<MetricModule, string>> = Object.freeze({
  area: 'Area habitat',
  hedgerow: 'Hedgerow',
  watercourse: 'Watercourse',
});

export function isMetricModule(value: unknown): value is MetricModule {
  return typeof value === 'string' && (METRIC_MODULES as readonly string[]).includes(value);
}

export function assertMetricModule(value: unknown): MetricModule {
  if (!isMetricModule(value)) {
    throw new TypeError(`Not a metric module: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Decimal places used for every monetary amount. Separate system from unit scale. */
export const MONEY_SCALE = 2;
