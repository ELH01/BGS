import type { MetricModule } from '@bgs/core';

/**
 * Logical fields that appear across the metric's input sheets.
 *
 * Named independently of any one sheet's column letters, so that a change in
 * the workbook layout is a change to a mapping table (see ./versions/) and
 * nothing else. This is the separation §4.7 of the specification asks for: the
 * solver and the importer speak in these names and never in cell addresses.
 */
export const METRIC_FIELDS = [
  'habitatReference',
  'proposedParcelRef',
  'broadHabitat',
  'habitatType',
  'watercourseType',
  'irreplaceable',
  'areaHectares',
  'lengthKm',
  'condition',
  'strategicSignificance',
  'spatialRiskCategory',
  'areaRetained',
  'areaEnhanced',
  'lengthRetained',
  'lengthEnhanced',
  'createdInAdvanceYears',
  'delayYears',
  'encroachmentWatercourse',
  'encroachmentRiparian',
  'userComments',
] as const;

export type MetricField = (typeof METRIC_FIELDS)[number];

/**
 * Fields holding a quantity rather than a label.
 *
 * Read back through `UnitQuantity`/parsing rather than as raw text, and written
 * as numbers so the workbook's own formulas treat them as such.
 */
export const NUMERIC_FIELDS: ReadonlySet<MetricField> = new Set<MetricField>([
  'areaHectares',
  'lengthKm',
  'areaRetained',
  'areaEnhanced',
  'lengthRetained',
  'lengthEnhanced',
  'createdInAdvanceYears',
  'delayYears',
]);

/** Whether a parcel is on the development site or off it. */
export type SiteContext = 'on-site' | 'off-site';

/** Which of the three intervention sheets a row belongs to. */
export type InterventionKind = 'baseline' | 'creation' | 'enhancement';

export interface SheetMapping {
  /**
   * Sheet name exactly as it appears in the workbook.
   *
   * Reproduced literally, including the workbook's own inconsistencies — see
   * the notes in ./versions/metric-4-0.ts. Correcting them here would simply
   * mean the sheet is never found.
   */
  readonly sheet: string;
  readonly module: MetricModule;
  readonly context: SiteContext;
  readonly kind: InterventionKind;
  /** First data row, 1-based, as Excel numbers them. */
  readonly firstRow: number;
  /** Last data row the sheet accepts. Rows beyond this are not written. */
  readonly lastRow: number;
  /**
   * Column letters per field. A field may map to more than one column: some
   * sheets repeat the habitat reference in a second place, and both copies
   * must be kept in step.
   */
  readonly columns: Readonly<Partial<Record<MetricField, readonly string[]>>>;
  /** Anything about this sheet a reader or writer should know. */
  readonly notes?: readonly string[];
}

export interface HeaderCellMapping {
  readonly sheet: string;
  readonly cells: Readonly<Record<string, string>>;
}

export interface MetricVersionMapping {
  readonly version: string;
  readonly label: string;
  readonly source: string;
  readonly status: 'unconfirmed' | 'confirmed';
  readonly sheets: readonly SheetMapping[];
  readonly header: HeaderCellMapping;
  /**
   * Points where the mapping is known to be uncertain, surfaced to the user
   * rather than buried. Each needs checking against a real workbook.
   */
  readonly discrepancies: readonly string[];
}

/** Row capacity of a sheet, used to reject an allocation that will not fit. */
export function sheetCapacity(mapping: SheetMapping): number {
  return mapping.lastRow - mapping.firstRow + 1;
}

/** Every column letter a sheet mapping touches, in a stable order. */
export function mappedColumns(mapping: SheetMapping): string[] {
  const seen: string[] = [];
  for (const columns of Object.values(mapping.columns)) {
    for (const column of columns ?? []) {
      if (!seen.includes(column)) seen.push(column);
    }
  }
  return seen;
}

/** Convert a column letter such as "AB" to its 1-based index. */
export function columnToIndex(letter: string): number {
  let index = 0;
  for (const character of letter.toUpperCase()) {
    const value = character.charCodeAt(0) - 64;
    if (value < 1 || value > 26) {
      throw new RangeError(`"${letter}" is not a column letter.`);
    }
    index = index * 26 + value;
  }
  return index;
}

/** Convert a 1-based column index to its letter form. */
export function indexToColumn(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`Column index must be a positive integer, received ${index}.`);
  }
  let remaining = index;
  let letters = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}
