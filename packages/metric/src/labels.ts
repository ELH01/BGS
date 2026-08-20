import type { LpaNcaBand } from '@bgs/core';

/**
 * The exact text the metric's own dropdowns use.
 *
 * This platform stores conditions, strategic significance and spatial risk as
 * stable slugs, because they outlive any one metric version. The workbook
 * wants the words its dropdown lists, and those belong with the version
 * mapping rather than with the domain.
 *
 * **These strings carry more risk than the cell addresses do.** A wrong column
 * writes a value somewhere visible, and someone notices. A wrong dropdown label
 * writes text the metric's lookup formulas do not recognise, and because data
 * validation only fires on manual entry, Excel accepts it silently — the units
 * come out as an error or a zero rather than as an obvious fault. Confirm these
 * against a real workbook's dropdown lists before relying on an export.
 */

export type ConditionSlug = 'n/a' | 'poor' | 'fairly-poor' | 'moderate' | 'fairly-good' | 'good';

export type StrategicSignificanceSlug =
  | 'formally-identified'
  | 'ecologically-desirable'
  | 'not-in-strategy';

export interface MetricLabels {
  readonly status: 'unconfirmed' | 'confirmed';
  readonly source: string;
  readonly condition: Readonly<Record<ConditionSlug, string>>;
  readonly strategicSignificance: Readonly<Record<StrategicSignificanceSlug, string>>;
  readonly spatialRisk: Readonly<Record<LpaNcaBand, string>>;
}

/**
 * Metric 4.0 dropdown text.
 *
 * PLACEHOLDER WORDING, pending confirmation against a sample workbook. The
 * slugs and the structure are right; the exact phrasing is the part to check.
 */
export const METRIC_4_0_LABELS: MetricLabels = Object.freeze({
  status: 'unconfirmed',
  source:
    'Wording not yet checked against a real workbook’s dropdown lists. A mismatch fails silently, so confirm before sending an export to a developer.',
  condition: Object.freeze({
    'n/a': 'N/A - Other',
    poor: 'Poor',
    'fairly-poor': 'Fairly Poor',
    moderate: 'Moderate',
    'fairly-good': 'Fairly Good',
    good: 'Good',
  }),
  strategicSignificance: Object.freeze({
    'formally-identified': 'Formally identified in local strategy',
    'ecologically-desirable': 'Location ecologically desirable but not in local strategy',
    'not-in-strategy': 'Area/compensation not in local strategy',
  }),
  spatialRisk: Object.freeze({
    'same-lpa': 'Inside LPA or NCA of impact site',
    'neighbouring-lpa-same-nca': 'Outside LPA or NCA of impact site but in neighbouring LPA or NCA',
    outside: 'Outside LPA or NCA of impact site',
  }),
});

const LABELS_BY_VERSION = new Map<string, MetricLabels>([['4.0', METRIC_4_0_LABELS]]);

export function getMetricLabels(version = '4.0'): MetricLabels {
  const labels = LABELS_BY_VERSION.get(version);
  if (!labels) {
    throw new RangeError(
      `No dropdown labels for metric version "${version}". Known versions: ${[...LABELS_BY_VERSION.keys()].join(', ')}.`,
    );
  }
  return labels;
}

export function registerMetricLabels(version: string, labels: MetricLabels): void {
  LABELS_BY_VERSION.set(version, labels);
}

export function conditionLabel(slug: ConditionSlug, version?: string): string {
  const label = getMetricLabels(version).condition[slug];
  if (!label) throw new RangeError(`No dropdown label for condition "${slug}".`);
  return label;
}

export function strategicSignificanceLabel(slug: StrategicSignificanceSlug, version?: string): string {
  const label = getMetricLabels(version).strategicSignificance[slug];
  if (!label) throw new RangeError(`No dropdown label for strategic significance "${slug}".`);
  return label;
}

export function spatialRiskLabel(band: LpaNcaBand, version?: string): string {
  const label = getMetricLabels(version).spatialRisk[band];
  if (!label) throw new RangeError(`No dropdown label for spatial risk band "${band}".`);
  return label;
}
