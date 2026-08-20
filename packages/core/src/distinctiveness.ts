/**
 * Distinctiveness bands as used by the DEFRA biodiversity metric.
 *
 * Ordered lowest to highest; the numeric rank is what the trading rules
 * compare, so that "or better" is a single comparison rather than a lookup.
 */
export const DISTINCTIVENESS_BANDS = ['very-low', 'low', 'medium', 'high', 'very-high'] as const;

export type DistinctivenessBand = (typeof DISTINCTIVENESS_BANDS)[number];

const RANK: Readonly<Record<DistinctivenessBand, number>> = Object.freeze({
  'very-low': 0,
  low: 1,
  medium: 2,
  high: 3,
  'very-high': 4,
});

export const DISTINCTIVENESS_LABEL: Readonly<Record<DistinctivenessBand, string>> = Object.freeze({
  'very-low': 'Very Low',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  'very-high': 'Very High',
});

export function distinctivenessRank(band: DistinctivenessBand): number {
  return RANK[band];
}

/** True when `offered` is of the same distinctiveness as `required`, or higher. */
export function isSameOrBetter(offered: DistinctivenessBand, required: DistinctivenessBand): boolean {
  return RANK[offered] >= RANK[required];
}

export function isDistinctivenessBand(value: unknown): value is DistinctivenessBand {
  return typeof value === 'string' && (DISTINCTIVENESS_BANDS as readonly string[]).includes(value);
}

/**
 * Read a distinctiveness band from a workbook cell, tolerating the spacing and
 * capitalisation variations that appear across metric versions.
 * Returns null rather than throwing, so a bad cell surfaces for correction.
 */
export function parseDistinctiveness(value: unknown): DistinctivenessBand | null {
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return isDistinctivenessBand(normalised) ? normalised : null;
}

/**
 * Condition bands. Carried on stock parcels for description and reporting;
 * the trading rules in this build compare distinctiveness, with condition
 * surfaced to the user rather than automatically enforced.
 */
export const CONDITION_BANDS = ['n/a', 'poor', 'fairly-poor', 'moderate', 'fairly-good', 'good'] as const;

export type ConditionBand = (typeof CONDITION_BANDS)[number];

export const CONDITION_LABEL: Readonly<Record<ConditionBand, string>> = Object.freeze({
  'n/a': 'N/A',
  poor: 'Poor',
  'fairly-poor': 'Fairly Poor',
  moderate: 'Moderate',
  'fairly-good': 'Fairly Good',
  good: 'Good',
});

export function isConditionBand(value: unknown): value is ConditionBand {
  return typeof value === 'string' && (CONDITION_BANDS as readonly string[]).includes(value);
}

export function parseCondition(value: unknown): ConditionBand | null {
  if (typeof value !== 'string') return null;
  const normalised = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return isConditionBand(normalised) ? normalised : null;
}
