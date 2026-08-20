import type { MetricModule } from '@bgs/core';
import type { InterventionKind, MetricVersionMapping, SheetMapping, SiteContext } from './fields.js';
import { METRIC_4_0 } from './versions/metric-4-0.js';

/**
 * Known metric versions.
 *
 * DEFRA revises the metric every few years — 2.0, 3.0, 3.1 and now 4.0 — so a
 * new version is a new entry here and nothing else. Version selection is
 * explicit and config-driven; the platform never tries to detect which version
 * a workbook is (§7), because getting that wrong silently writes into the
 * wrong cells.
 */
const VERSIONS = new Map<string, MetricVersionMapping>([[METRIC_4_0.version, METRIC_4_0]]);

/** The version used when none is specified. */
export const DEFAULT_METRIC_VERSION = METRIC_4_0.version;

export function availableMetricVersions(): MetricVersionMapping[] {
  return [...VERSIONS.values()];
}

export function getMetricMapping(version: string = DEFAULT_METRIC_VERSION): MetricVersionMapping {
  const mapping = VERSIONS.get(version);
  if (!mapping) {
    const known = [...VERSIONS.keys()].join(', ');
    throw new RangeError(`No cell mapping for metric version "${version}". Known versions: ${known}.`);
  }
  return mapping;
}

/** Register a mapping for a version this build does not ship with. */
export function registerMetricMapping(mapping: MetricVersionMapping): void {
  VERSIONS.set(mapping.version, mapping);
}

export interface SheetQuery {
  module: MetricModule;
  context: SiteContext;
  kind: InterventionKind;
}

export function findSheet(mapping: MetricVersionMapping, query: SheetQuery): SheetMapping {
  const sheet = mapping.sheets.find(
    (candidate) =>
      candidate.module === query.module &&
      candidate.context === query.context &&
      candidate.kind === query.kind,
  );

  if (!sheet) {
    throw new RangeError(
      `Metric ${mapping.version} has no ${query.context} ${query.kind} sheet for the ${query.module} module.`,
    );
  }
  return sheet;
}

/**
 * The sheet an off-site allocation from a habitat bank is written into, for a
 * given module.
 *
 * Units bought from a bank are habitat the bank created, so they belong on the
 * off-site *creation* sheet — D-2, E-2 or F-2 depending on module. Enhancement
 * sheets describe improvements to habitat that was already there, which is not
 * what a bank allocation is.
 */
export function offSiteAllocationSheet(
  mapping: MetricVersionMapping,
  module: MetricModule,
): SheetMapping {
  return findSheet(mapping, { module, context: 'off-site', kind: 'creation' });
}
