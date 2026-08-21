import ExcelJS from 'exceljs';
import { MODULE_LABEL, type MetricModule } from '@bgs/core';

/**
 * A spreadsheet of the commercial position: what is quoted, what is reserved,
 * what has sold, and what is left.
 *
 * Built as three sheets because there are three questions and they want
 * different shapes. "Which deals are live?" is a list of quotes. "What have I
 * committed from each parcel?" is a list of allocation lines. "How much is left
 * to sell?" is a list of parcels. Flattening those into one sheet would serve
 * none of them well.
 *
 * Numbers are written as numbers so the sheet can be sorted and totalled, but
 * they are converted from the stored decimal strings at the last possible
 * moment and given an explicit number format at the module's own precision, so
 * what is displayed matches what the platform holds.
 */

export type PositionStatus = 'draft' | 'quoted' | 'reserved' | 'sold' | 'cancelled';

export interface PositionAllocationRow {
  quoteReference: string;
  quoteStatus: PositionStatus;
  priority: string;
  purchaser: string;
  developmentSite: string | null;
  bankOperator: string;
  site: string;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: string;
  /** Units drawn from the parcel, before the spatial multiplier. */
  rawQuantity: string;
  spatialBand: string;
  spatialFactor: string;
  /** What those raw units deliver after the multiplier. */
  effectiveUnits: string;
  unitPrice: string;
  lineTotal: string;
  createdAt: Date;
  lastActivityAt: Date;
  reservationExpiresAt: Date | null;
  soldAt: Date | null;
}

export interface PositionQuoteRow {
  reference: string;
  status: PositionStatus;
  priority: string;
  purchaser: string;
  bankOperator: string | null;
  lineCount: number;
  totalExcludingVat: string;
  vat: string;
  totalIncludingVat: string;
  isStale: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  reservationExpiresAt: Date | null;
  soldAt: Date | null;
  planningApplicationReference: string | null;
}

export interface PositionParcelRow {
  bankOperator: string;
  site: string;
  parcelReference: string;
  module: MetricModule;
  broadHabitat: string;
  habitatType: string;
  distinctiveness: string;
  condition: string;
  totalUnits: string;
  quotedUnits: string;
  reservedUnits: string;
  soldUnits: string;
  availableUnits: string;
  isOverExposed: boolean;
  listPricePerUnit: string | null;
}

export interface PositionExportInput {
  organisationName: string;
  generatedAt: Date;
  /** What the export was filtered to, printed so a saved file explains itself. */
  scope: { bankOperator?: string | undefined; statuses?: readonly PositionStatus[] | undefined };
  allocations: readonly PositionAllocationRow[];
  quotes: readonly PositionQuoteRow[];
  parcels: readonly PositionParcelRow[];
}

const HEADER_FILL = 'FF385B4F';
const HEADER_FONT = 'FFFAF9F1';

/** Decimal places a module's unit quantities are shown at (§2). */
function unitFormat(module: MetricModule): string {
  return module === 'area' ? '0.0000' : '0.000';
}

const MONEY_FORMAT = '£#,##0.00';
const DATE_FORMAT = 'dd/mm/yyyy';

interface Column {
  header: string;
  key: string;
  width: number;
  /** Number format, or 'unit' to take it from the row's own module. */
  format?: string | 'unit';
}

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: readonly Column[]): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width }));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: HEADER_FONT } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;

  return sheet;
}

/** Apply per-column number formats once the rows are in. */
function applyFormats(
  sheet: ExcelJS.Worksheet,
  columns: readonly Column[],
  moduleOf: (rowNumber: number) => MetricModule | null,
): void {
  columns.forEach((column, index) => {
    if (!column.format) return;
    const excelColumn = sheet.getColumn(index + 1);

    excelColumn.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber === 1) return;
      if (column.format === 'unit') {
        const module = moduleOf(rowNumber);
        cell.numFmt = module ? unitFormat(module) : '0.0000';
      } else {
        cell.numFmt = column.format as string;
      }
    });
  });
}

/**
 * Convert a stored decimal string to a number for the spreadsheet.
 *
 * This is the one place the platform's exact decimals become floats, and it is
 * deliberate: a spreadsheet the user will sort and total has to hold numbers,
 * not text. The value is written at the module's own precision and every
 * quantity here is at most four decimal places, well inside what a double
 * represents exactly, so nothing is lost on the way out. Nothing is read back
 * from this file.
 */
function numeric(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const ALLOCATION_COLUMNS: readonly Column[] = [
  { header: 'Quote', key: 'quoteReference', width: 12 },
  { header: 'Status', key: 'quoteStatus', width: 11 },
  { header: 'Priority', key: 'priority', width: 9 },
  { header: 'Purchaser', key: 'purchaser', width: 28 },
  { header: 'Development site', key: 'developmentSite', width: 26 },
  { header: 'Bank', key: 'bankOperator', width: 24 },
  { header: 'Site', key: 'site', width: 22 },
  { header: 'Parcel', key: 'parcelReference', width: 12 },
  { header: 'Module', key: 'module', width: 15 },
  { header: 'Broad habitat', key: 'broadHabitat', width: 22 },
  { header: 'Habitat type', key: 'habitatType', width: 28 },
  { header: 'Distinctiveness', key: 'distinctiveness', width: 14 },
  { header: 'Units drawn', key: 'rawQuantity', width: 13, format: 'unit' },
  { header: 'Spatial band', key: 'spatialBand', width: 26 },
  { header: 'Multiplier', key: 'spatialFactor', width: 10, format: '0.00' },
  { header: 'Units delivered', key: 'effectiveUnits', width: 15, format: 'unit' },
  { header: 'Unit price', key: 'unitPrice', width: 13, format: MONEY_FORMAT },
  { header: 'Line total', key: 'lineTotal', width: 14, format: MONEY_FORMAT },
  { header: 'Created', key: 'createdAt', width: 12, format: DATE_FORMAT },
  { header: 'Last activity', key: 'lastActivityAt', width: 13, format: DATE_FORMAT },
  { header: 'Reservation expires', key: 'reservationExpiresAt', width: 18, format: DATE_FORMAT },
  { header: 'Sold', key: 'soldAt', width: 12, format: DATE_FORMAT },
];

const QUOTE_COLUMNS: readonly Column[] = [
  { header: 'Quote', key: 'reference', width: 12 },
  { header: 'Status', key: 'status', width: 11 },
  { header: 'Stale', key: 'isStale', width: 8 },
  { header: 'Priority', key: 'priority', width: 9 },
  { header: 'Purchaser', key: 'purchaser', width: 28 },
  { header: 'Bank', key: 'bankOperator', width: 24 },
  { header: 'Lines', key: 'lineCount', width: 7 },
  { header: 'Total excluding VAT', key: 'totalExcludingVat', width: 18, format: MONEY_FORMAT },
  { header: 'VAT', key: 'vat', width: 13, format: MONEY_FORMAT },
  { header: 'Total including VAT', key: 'totalIncludingVat', width: 18, format: MONEY_FORMAT },
  { header: 'Created', key: 'createdAt', width: 12, format: DATE_FORMAT },
  { header: 'Last activity', key: 'lastActivityAt', width: 13, format: DATE_FORMAT },
  { header: 'Reservation expires', key: 'reservationExpiresAt', width: 18, format: DATE_FORMAT },
  { header: 'Sold', key: 'soldAt', width: 12, format: DATE_FORMAT },
  { header: 'Planning reference', key: 'planningApplicationReference', width: 20 },
];

const PARCEL_COLUMNS: readonly Column[] = [
  { header: 'Bank', key: 'bankOperator', width: 24 },
  { header: 'Site', key: 'site', width: 22 },
  { header: 'Parcel', key: 'parcelReference', width: 12 },
  { header: 'Module', key: 'module', width: 15 },
  { header: 'Broad habitat', key: 'broadHabitat', width: 22 },
  { header: 'Habitat type', key: 'habitatType', width: 28 },
  { header: 'Distinctiveness', key: 'distinctiveness', width: 14 },
  { header: 'Condition', key: 'condition', width: 13 },
  { header: 'Total units', key: 'totalUnits', width: 13, format: 'unit' },
  { header: 'Quoted', key: 'quotedUnits', width: 12, format: 'unit' },
  { header: 'Reserved', key: 'reservedUnits', width: 12, format: 'unit' },
  { header: 'Sold', key: 'soldUnits', width: 12, format: 'unit' },
  { header: 'Available', key: 'availableUnits', width: 13, format: 'unit' },
  { header: 'Over-quoted', key: 'isOverExposed', width: 12 },
  { header: 'List price', key: 'listPricePerUnit', width: 13, format: MONEY_FORMAT },
];

export async function buildPositionWorkbook(input: PositionExportInput): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = input.organisationName;
  workbook.created = input.generatedAt;

  // A cover sheet, because a spreadsheet found on a drive months later should
  // say what it is, when it was taken and what it was filtered to. Without
  // that, a partial export is indistinguishable from a complete one.
  const cover = workbook.addWorksheet('About');
  cover.columns = [{ width: 26 }, { width: 70 }];
  const coverRows: Array<[string, string]> = [
    ['Report', 'Quoted, reserved and sold positions'],
    ['Organisation', input.organisationName],
    ['Generated', input.generatedAt.toISOString()],
    ['Bank', input.scope.bankOperator ?? 'All banks'],
    [
      'Statuses',
      input.scope.statuses && input.scope.statuses.length > 0
        ? input.scope.statuses.join(', ')
        : 'All except cancelled',
    ],
    ['Allocation lines', String(input.allocations.length)],
    ['Quotes', String(input.quotes.length)],
    ['Parcels', String(input.parcels.length)],
    ['', ''],
    [
      'Note on units',
      'Units drawn is what leaves the parcel. Units delivered is what it is worth to the purchaser after the spatial multiplier. The two differ whenever the bank is not in the development’s own area.',
    ],
    [
      'Note on availability',
      'A quote is soft and does not reduce availability; a reservation and a sale do. A parcel can therefore be quoted beyond what it holds, which shows as over-quoted.',
    ],
  ];
  for (const [label, value] of coverRows) {
    const row = cover.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }

  const allocations = addSheet(workbook, 'Allocations', ALLOCATION_COLUMNS);
  const allocationModules: MetricModule[] = [];
  for (const row of input.allocations) {
    allocationModules.push(row.module);
    allocations.addRow({
      ...row,
      module: MODULE_LABEL[row.module],
      rawQuantity: numeric(row.rawQuantity),
      spatialFactor: numeric(row.spatialFactor),
      effectiveUnits: numeric(row.effectiveUnits),
      unitPrice: numeric(row.unitPrice),
      lineTotal: numeric(row.lineTotal),
    });
  }
  applyFormats(allocations, ALLOCATION_COLUMNS, (rowNumber) => allocationModules[rowNumber - 2] ?? null);
  if (input.allocations.length > 0) {
    allocations.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ALLOCATION_COLUMNS.length } };
  }

  const quotes = addSheet(workbook, 'Quotes', QUOTE_COLUMNS);
  for (const row of input.quotes) {
    quotes.addRow({
      ...row,
      isStale: row.isStale ? 'Yes' : '',
      totalExcludingVat: numeric(row.totalExcludingVat),
      vat: numeric(row.vat),
      totalIncludingVat: numeric(row.totalIncludingVat),
    });
  }
  applyFormats(quotes, QUOTE_COLUMNS, () => null);
  if (input.quotes.length > 0) {
    quotes.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: QUOTE_COLUMNS.length } };
  }

  const parcels = addSheet(workbook, 'Stock position', PARCEL_COLUMNS);
  const parcelModules: MetricModule[] = [];
  for (const row of input.parcels) {
    parcelModules.push(row.module);
    parcels.addRow({
      ...row,
      module: MODULE_LABEL[row.module],
      isOverExposed: row.isOverExposed ? 'Yes' : '',
      totalUnits: numeric(row.totalUnits),
      quotedUnits: numeric(row.quotedUnits),
      reservedUnits: numeric(row.reservedUnits),
      soldUnits: numeric(row.soldUnits),
      availableUnits: numeric(row.availableUnits),
      listPricePerUnit: numeric(row.listPricePerUnit),
    });
  }
  applyFormats(parcels, PARCEL_COLUMNS, (rowNumber) => parcelModules[rowNumber - 2] ?? null);
  if (input.parcels.length > 0) {
    parcels.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: PARCEL_COLUMNS.length } };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** Filename that sorts chronologically and says what it holds. */
export function positionExportFilename(generatedAt: Date, bankOperator?: string): string {
  const stamp = generatedAt.toISOString().slice(0, 10);
  const scope = bankOperator ? `-${bankOperator.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : '';
  return `Positions${scope}-${stamp}.xlsx`;
}
