import Decimal from 'decimal.js';
import { UnitQuantity, type LpaNcaBand, type MetricModule } from '@bgs/core';
import {
  conditionLabel,
  getMetricLabels,
  spatialRiskLabel,
  strategicSignificanceLabel,
  type ConditionSlug,
  type StrategicSignificanceSlug,
} from './labels.js';
import { NUMERIC_FIELDS, sheetCapacity, type MetricField, type SheetMapping } from './fields.js';
import { getMetricMapping, offSiteAllocationSheet } from './registry.js';
import type { CellValue, CellWrite } from './sheet-xml.js';
import { patchWorkbook, type WorkbookPatchResult } from './workbook.js';

/**
 * Writes a solved allocation into a copy of the developer's metric workbook
 * (§4.7).
 *
 * Units are not what the metric takes. Its input sheets take an **area in
 * hectares**, or a **length in kilometres**, and compute biodiversity units
 * themselves from distinctiveness, condition, strategic significance and the
 * spatial multiplier. So an allocation of 2.3457 units is written as the
 * extent of habitat that produces those units:
 *
 *   extent written = allocated units x parcel extent / parcel total units
 *
 * — the fraction of the parcel being sold, applied to its physical size.
 *
 * Nothing here evaluates the metric's own formulas. The workbook is marked to
 * recalculate on open, and Excel does the arithmetic that matters.
 */

const D = Decimal.clone({ precision: 40, toExpNeg: -9e15, toExpPos: 9e15 });

/** Decimal places extents are written at. Wide enough not to lose a small parcel. */
const EXTENT_SCALE = 6;

export interface OffSiteAllocationRow {
  /** Reference the purchaser will see against this line. */
  reference: string;
  broadHabitat: string;
  /** Habitat type for area and hedgerow; watercourse type for watercourse. */
  habitatType: string;
  /** Condition label spelled as the metric's own dropdown spells it. */
  condition: string;
  strategicSignificance: string;
  /** Spatial risk band label, as the metric's dropdown spells it. */
  spatialRiskCategory: string;
  /** Raw units drawn from the parcel, before the spatial multiplier. */
  allocatedUnits: UnitQuantity;
  /** The parcel's total units, used to work out what fraction is being sold. */
  parcelTotalUnits: UnitQuantity;
  /** The parcel's physical size: hectares for area, kilometres otherwise. */
  parcelExtent: string;
  createdInAdvanceYears?: string | number | undefined;
  delayYears?: string | number | undefined;
  userComments?: string | undefined;
}

/**
 * A stock parcel as the exporter needs it: the metric inputs the bank's own
 * workbook used to arrive at this parcel's units.
 *
 * All of them have to be written into the developer's workbook, because that
 * workbook recomputes the units from scratch. Omit one and it computes a
 * different figure from the one the parcel was sold on.
 */
export interface ParcelForExport {
  reference: string;
  broadHabitat: string;
  /** Habitat type for area and hedgerow; watercourse type for watercourse. */
  habitatType: string;
  condition: ConditionSlug;
  strategicSignificance: StrategicSignificanceSlug | null;
  totalUnits: UnitQuantity;
  /** Hectares for area, kilometres otherwise. */
  extent: string | null;
  habitatCreatedInAdvanceYears: string | null;
  delayYears: string | null;
}

export interface ExportReadiness {
  ready: boolean;
  /** Plain-English list of what is missing, for showing next to the parcel. */
  missing: string[];
}

/**
 * Whether a parcel carries everything the developer's workbook needs.
 *
 * Worth checking before the user reaches an export, so a missing figure is a
 * prompt on the stock screen rather than a failure at the point of sending a
 * file to a client.
 */
export function checkParcelExportReadiness(parcel: ParcelForExport): ExportReadiness {
  const missing: string[] = [];

  if (parcel.extent === null || parcel.extent.trim() === '') {
    missing.push('physical extent (hectares or kilometres)');
  }
  if (parcel.strategicSignificance === null) {
    missing.push('strategic significance');
  }
  if (parcel.habitatCreatedInAdvanceYears === null) {
    // Not fatal, but silence here understates a banked parcel, so it is
    // surfaced rather than defaulted quietly.
    missing.push('years the habitat was created in advance');
  }
  if (parcel.totalUnits.isZero()) {
    missing.push('units (the parcel generates none)');
  }

  return { ready: missing.length === 0, missing };
}

/**
 * Build an export row from a stored parcel and one allocation against it.
 *
 * This is where stored slugs become the words the workbook's dropdowns use.
 * Doing it here rather than at each call site means there is exactly one place
 * that has to be right when a metric version changes its wording.
 */
export function allocationRowFromParcel(
  parcel: ParcelForExport,
  allocation: {
    allocatedUnits: UnitQuantity;
    spatialBand: LpaNcaBand;
    userComments?: string | undefined;
  },
  metricVersion?: string,
): OffSiteAllocationRow {
  if (parcel.extent === null) {
    throw new RangeError(
      `Parcel "${parcel.reference}" has no extent recorded, so the area or length to write into the metric cannot be worked out.`,
    );
  }
  if (parcel.strategicSignificance === null) {
    throw new RangeError(
      `Parcel "${parcel.reference}" has no strategic significance recorded. The metric uses it to compute units, so writing the parcel without it would give the developer a different figure from the one quoted.`,
    );
  }

  return {
    reference: parcel.reference,
    broadHabitat: parcel.broadHabitat,
    habitatType: parcel.habitatType,
    condition: conditionLabel(parcel.condition, metricVersion),
    strategicSignificance: strategicSignificanceLabel(parcel.strategicSignificance, metricVersion),
    spatialRiskCategory: spatialRiskLabel(allocation.spatialBand, metricVersion),
    allocatedUnits: allocation.allocatedUnits,
    parcelTotalUnits: parcel.totalUnits,
    parcelExtent: parcel.extent,
    // Written even when zero: an empty cell and a stated zero are not the same
    // to the metric, and a bank parcel almost always has a non-zero advance.
    createdInAdvanceYears: parcel.habitatCreatedInAdvanceYears ?? '0',
    delayYears: parcel.delayYears ?? '0',
    ...(allocation.userComments === undefined ? {} : { userComments: allocation.userComments }),
  };
}

export interface OffSiteExportOptions {
  metricVersion?: string | undefined;
  /**
   * Row to begin writing at, defaulting to the sheet's first data row.
   *
   * Worth setting deliberately. A developer's workbook may already carry
   * off-site entries from another provider, and writing from the top would
   * overwrite them.
   */
  startRow?: Partial<Record<MetricModule, number>> | undefined;
}

export interface OffSiteExportResult extends WorkbookPatchResult {
  /** What was written where, for showing back to the user and for the audit log. */
  rowsWritten: Array<{
    module: MetricModule;
    sheet: string;
    firstRow: number;
    lastRow: number;
    rowCount: number;
  }>;
  /** Extent written per row, so the figures can be checked without reopening Excel. */
  extents: Array<{ module: MetricModule; reference: string; extent: string }>;
  warnings: string[];
}

/**
 * The extent to write for one allocation row.
 *
 * Rounded **up**: the extent determines the units the metric will compute, and
 * rounding down would have the developer's own workbook show fractionally
 * fewer units than they bought — which is the failure this whole export exists
 * to prevent. Rounding up over-delivers by less than a millionth of a hectare.
 */
export function extentForAllocation(row: OffSiteAllocationRow): string {
  if (row.allocatedUnits.module !== row.parcelTotalUnits.module) {
    throw new TypeError('Allocated units and parcel total units must be the same module.');
  }
  if (row.parcelTotalUnits.isZero()) {
    throw new RangeError(
      `Parcel "${row.reference}" has no units, so the extent for an allocation from it is undefined.`,
    );
  }

  const parcelExtent = new D(row.parcelExtent);
  if (!parcelExtent.isFinite() || parcelExtent.lessThanOrEqualTo(0)) {
    throw new RangeError(
      `Parcel "${row.reference}" needs a positive extent before an allocation from it can be written into a metric.`,
    );
  }

  const fraction = row.allocatedUnits.toDecimal().dividedBy(row.parcelTotalUnits.toDecimal());
  return parcelExtent.times(fraction).toDecimalPlaces(EXTENT_SCALE, Decimal.ROUND_UP).toFixed(EXTENT_SCALE);
}

function cellValue(field: MetricField, raw: string | number | undefined): CellValue | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (NUMERIC_FIELDS.has(field)) {
    return { kind: 'number', value: String(raw) };
  }
  return { kind: 'text', value: String(raw) };
}

/** Turn one allocation row into the field values that sheet expects. */
function fieldsForRow(
  module: MetricModule,
  row: OffSiteAllocationRow,
  extent: string,
): Partial<Record<MetricField, string | number>> {
  const fields: Partial<Record<MetricField, string | number>> = {
    habitatReference: row.reference,
    proposedParcelRef: row.reference,
    condition: row.condition,
    strategicSignificance: row.strategicSignificance,
    spatialRiskCategory: row.spatialRiskCategory,
  };

  if (module === 'area') {
    fields.broadHabitat = row.broadHabitat;
    fields.habitatType = row.habitatType;
    fields.areaHectares = extent;
  } else if (module === 'hedgerow') {
    fields.habitatType = row.habitatType;
    fields.lengthKm = extent;
  } else {
    fields.watercourseType = row.habitatType;
    fields.lengthKm = extent;
  }

  if (row.createdInAdvanceYears !== undefined) fields.createdInAdvanceYears = row.createdInAdvanceYears;
  if (row.delayYears !== undefined) fields.delayYears = row.delayYears;
  if (row.userComments !== undefined) fields.userComments = row.userComments;

  return fields;
}

function buildWrites(
  sheet: SheetMapping,
  rows: readonly OffSiteAllocationRow[],
  startRow: number,
  extents: string[],
  warnings: string[],
): CellWrite[] {
  const writes: CellWrite[] = [];

  rows.forEach((row, index) => {
    const rowNumber = startRow + index;
    const fields = fieldsForRow(sheet.module, row, extents[index] ?? '0');

    for (const [field, raw] of Object.entries(fields) as Array<[MetricField, string | number]>) {
      const columns = sheet.columns[field];
      if (!columns) {
        // The sheet has no home for this field. Reported rather than dropped,
        // since a missing spatial risk column changes what the metric computes.
        warnings.push(
          `${sheet.sheet} has no column mapped for "${field}", so that value was not written for ${row.reference}.`,
        );
        continue;
      }

      const value = cellValue(field, raw);
      if (!value) continue;

      // A field mapped to more than one column is written to all of them; the
      // workbook expects the copies to agree.
      for (const column of columns) {
        writes.push({ column, row: rowNumber, value });
      }
    }
  });

  return writes;
}

/**
 * Write a solved allocation into a copy of the developer's metric workbook.
 *
 * The three modules are written to three separate sheets and never combined.
 */
export function writeOffSiteAllocation(
  workbook: Uint8Array,
  allocation: Readonly<Partial<Record<MetricModule, readonly OffSiteAllocationRow[]>>>,
  options: OffSiteExportOptions = {},
): OffSiteExportResult {
  const mapping = getMetricMapping(options.metricVersion);
  const warnings: string[] = [];
  const rowsWritten: OffSiteExportResult['rowsWritten'] = [];
  const extentsOut: OffSiteExportResult['extents'] = [];
  const sheetWrites: Array<{ sheet: string; writes: CellWrite[] }> = [];

  if (mapping.status === 'unconfirmed') {
    warnings.push(
      `The cell mapping for metric ${mapping.version} has not been verified against a sample workbook. Check the written sheets before sending this file to a developer.`,
    );
  }

  const labels = getMetricLabels(options.metricVersion);
  if (labels.status === 'unconfirmed') {
    warnings.push(
      `The dropdown wording for metric ${mapping.version} has not been checked against a real workbook. A label the metric does not recognise is accepted silently and makes its unit calculation fail, so confirm the written cells show real values rather than errors.`,
    );
  }

  for (const [module, rows] of Object.entries(allocation) as Array<
    [MetricModule, readonly OffSiteAllocationRow[] | undefined]
  >) {
    if (!rows || rows.length === 0) continue;

    const sheet = offSiteAllocationSheet(mapping, module);
    const startRow = options.startRow?.[module] ?? sheet.firstRow;

    if (startRow < sheet.firstRow) {
      throw new RangeError(
        `${sheet.sheet} data starts at row ${sheet.firstRow}; row ${startRow} is above the input area.`,
      );
    }

    const lastRow = startRow + rows.length - 1;
    if (lastRow > sheet.lastRow) {
      throw new RangeError(
        `${rows.length} ${module} rows starting at row ${startRow} would run past row ${sheet.lastRow}, ` +
          `which is the last row ${sheet.sheet} accepts (${sheetCapacity(sheet)} rows in total).`,
      );
    }

    const extents = rows.map((row) => {
      const extent = extentForAllocation(row);
      extentsOut.push({ module, reference: row.reference, extent });
      return extent;
    });

    sheetWrites.push({ sheet: sheet.sheet, writes: buildWrites(sheet, rows, startRow, extents, warnings) });
    rowsWritten.push({ module, sheet: sheet.sheet, firstRow: startRow, lastRow, rowCount: rows.length });
  }

  const result = patchWorkbook(workbook, sheetWrites);

  if (result.overwrittenFormulas.length > 0) {
    warnings.push(
      `Wrote over ${result.overwrittenFormulas.length} cell(s) that held a formula: ` +
        `${result.overwrittenFormulas.slice(0, 10).join(', ')}. ` +
        'The metric’s input cells should not contain formulas, so this suggests the cell mapping is pointing at a calculated cell.',
    );
  }

  return { ...result, rowsWritten, extents: extentsOut, warnings };
}
