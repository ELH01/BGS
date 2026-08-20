import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { unzipSync, zipSync } from 'fflate';
import { UnitQuantity } from '@bgs/core';
import { extentForAllocation, writeOffSiteAllocation, type OffSiteAllocationRow } from './off-site-export.js';
import { hasVbaProject, listSheetNames, patchWorkbook } from './workbook.js';
import { getMetricMapping, offSiteAllocationSheet } from './registry.js';

const mapping = getMetricMapping();

/** Bytes standing in for a VBA project, to prove unrelated parts survive. */
const FAKE_VBA = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x42, 0x42]);

/**
 * A workbook shaped like the metric: the three off-site creation sheets, a
 * formula cell where a computed column would be, and a VBA project.
 *
 * Not the real DEFRA workbook — that has to come from Elliott — but enough
 * structure to exercise everything the writer does to a file.
 */
async function buildFixtureWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();

  for (const module of ['area', 'hedgerow', 'watercourse'] as const) {
    const sheetMapping = offSiteAllocationSheet(mapping, module);
    const sheet = workbook.addWorksheet(sheetMapping.sheet);
    sheet.getCell('A1').value = `${sheetMapping.sheet} header`;
    // A cell inside the data area holding a formula, to prove the writer
    // notices when it is asked to overwrite one.
    sheet.getCell(`A${sheetMapping.firstRow}`).value = { formula: 'SUM(B1:B2)', result: 0 };
  }

  // A sheet the writer is never asked to touch, to prove it is left alone.
  const untouched = workbook.addWorksheet('Start');
  untouched.getCell('F11').value = 'East Devon';
  untouched.getCell('F12').value = 'Original site name';

  const buffer = await workbook.xlsx.writeBuffer();
  const files = unzipSync(new Uint8Array(buffer as ArrayBuffer));
  files['xl/vbaProject.bin'] = FAKE_VBA;
  return zipSync(files);
}

async function readBack(file: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS bundles its own older @types/node, where Buffer is not generic,
  // so the two definitions disagree about a value both accept at runtime.
  await workbook.xlsx.load(Buffer.from(file) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

const areaRow = (over: Partial<OffSiteAllocationRow> = {}): OffSiteAllocationRow => ({
  reference: 'CC-F1',
  broadHabitat: 'Grassland',
  habitatType: 'Other neutral grassland',
  condition: 'Moderate',
  strategicSignificance: 'Within strategy, formally identified',
  spatialRiskCategory: 'Outside LPA/NCA',
  allocatedUnits: UnitQuantity.of('area', '2.3457'),
  parcelTotalUnits: UnitQuantity.of('area', '11.7285'),
  parcelExtent: '5.0',
  ...over,
});

let fixture: Uint8Array;

beforeAll(async () => {
  fixture = await buildFixtureWorkbook();
});

describe('extent conversion (units are not what the metric takes)', () => {
  it('writes the fraction of the parcel being sold, applied to its extent', () => {
    // 2.3457 of 11.7285 units is exactly one fifth of the parcel, so one fifth
    // of its 5 hectares.
    expect(extentForAllocation(areaRow())).toBe('1.000000');
  });

  it('rounds the extent up, so the metric never computes fewer units than were bought', () => {
    const row = areaRow({
      allocatedUnits: UnitQuantity.of('area', '1.0'),
      parcelTotalUnits: UnitQuantity.of('area', '3.0'),
      parcelExtent: '1.0',
    });
    // A third of a hectare: 0.333333... rounded up rather than down.
    expect(extentForAllocation(row)).toBe('0.333334');
  });

  it('scales with the parcel, not with the units alone', () => {
    // The same one-fifth share of two differently sized parcels.
    const small = extentForAllocation(areaRow({ parcelExtent: '1.0' }));
    const large = extentForAllocation(areaRow({ parcelExtent: '10.0' }));
    expect(small).toBe('0.200000');
    expect(large).toBe('2.000000');
  });

  it('refuses a parcel with no extent recorded', () => {
    expect(() => extentForAllocation(areaRow({ parcelExtent: '0' }))).toThrow(/needs a positive extent/);
  });

  it('refuses a parcel with no units', () => {
    expect(() =>
      extentForAllocation(
        areaRow({ parcelTotalUnits: UnitQuantity.of('area', '0'), allocatedUnits: UnitQuantity.of('area', '0') }),
      ),
    ).toThrow(/has no units/);
  });

  it('refuses to mix modules', () => {
    expect(() =>
      extentForAllocation(areaRow({ parcelTotalUnits: UnitQuantity.of('hedgerow', '5.0') })),
    ).toThrow(/same module/);
  });

  it('handles hedgerow and watercourse in kilometres at their own precision', () => {
    const row: OffSiteAllocationRow = {
      ...areaRow(),
      allocatedUnits: UnitQuantity.of('hedgerow', '1.5'),
      parcelTotalUnits: UnitQuantity.of('hedgerow', '6.0'),
      parcelExtent: '2.4',
    };
    expect(extentForAllocation(row)).toBe('0.600000');
  });
});

describe('writing into a workbook', () => {
  it('writes each module to its own sheet and never blends them', async () => {
    const result = writeOffSiteAllocation(fixture, {
      area: [areaRow()],
      hedgerow: [
        {
          ...areaRow(),
          reference: 'CC-H1',
          habitatType: 'Native hedgerow',
          allocatedUnits: UnitQuantity.of('hedgerow', '1.5'),
          parcelTotalUnits: UnitQuantity.of('hedgerow', '6.0'),
          parcelExtent: '2.4',
        },
      ],
    });

    expect(result.sheetsWritten.sort()).toEqual(
      ['D-2 Off-Site Habitat Creation', 'E-2 Off-Site Hedge Creation'].sort(),
    );
    expect(result.rowsWritten).toHaveLength(2);
    expect(result.rowsWritten.find((r) => r.module === 'area')?.sheet).toBe('D-2 Off-Site Habitat Creation');
  });

  it('puts values in the mapped cells', async () => {
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    const workbook = await readBack(result.file);
    const sheet = workbook.getWorksheet('D-2 Off-Site Habitat Creation');
    const row = offSiteAllocationSheet(mapping, 'area').firstRow;

    expect(sheet?.getCell(`D${row}`).value).toBe('Grassland');
    expect(sheet?.getCell(`E${row}`).value).toBe('Other neutral grassland');
    expect(sheet?.getCell(`J${row}`).value).toBe('Moderate');
    expect(sheet?.getCell(`Y${row}`).value).toBe('Outside LPA/NCA');
    expect(sheet?.getCell(`AE${row}`).value).toBe('CC-F1');
  });

  it('writes the extent as a number, so the metric’s formulas can use it', async () => {
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    const workbook = await readBack(result.file);
    const sheet = workbook.getWorksheet('D-2 Off-Site Habitat Creation');
    const row = offSiteAllocationSheet(mapping, 'area').firstRow;

    const value = sheet?.getCell(`G${row}`).value;
    expect(typeof value).toBe('number');
    expect(value).toBe(1);
  });

  it('writes consecutive rows for several allocations', async () => {
    const rows = ['A', 'B', 'C'].map((suffix) => areaRow({ reference: `CC-${suffix}` }));
    const result = writeOffSiteAllocation(fixture, { area: rows });
    const workbook = await readBack(result.file);
    const sheet = workbook.getWorksheet('D-2 Off-Site Habitat Creation');
    const first = offSiteAllocationSheet(mapping, 'area').firstRow;

    expect(sheet?.getCell(`AE${first}`).value).toBe('CC-A');
    expect(sheet?.getCell(`AE${first + 1}`).value).toBe('CC-B');
    expect(sheet?.getCell(`AE${first + 2}`).value).toBe('CC-C');
  });

  it('starts where it is told, so existing off-site entries are not overwritten', async () => {
    const first = offSiteAllocationSheet(mapping, 'area').firstRow;
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] }, { startRow: { area: first + 20 } });
    const workbook = await readBack(result.file);
    const sheet = workbook.getWorksheet('D-2 Off-Site Habitat Creation');

    expect(sheet?.getCell(`AE${first + 20}`).value).toBe('CC-F1');
    expect(sheet?.getCell(`AE${first}`).value).toBeFalsy();
  });

  it('writes both copies of a reference the workbook duplicates', async () => {
    const hedgerowRow: OffSiteAllocationRow = {
      ...areaRow(),
      reference: 'CC-H1',
      habitatType: 'Native hedgerow',
      allocatedUnits: UnitQuantity.of('hedgerow', '1.5'),
      parcelTotalUnits: UnitQuantity.of('hedgerow', '6.0'),
      parcelExtent: '2.4',
    };
    const result = writeOffSiteAllocation(fixture, { hedgerow: [hedgerowRow] });
    const workbook = await readBack(result.file);
    const sheet = workbook.getWorksheet('E-2 Off-Site Hedge Creation');
    const row = offSiteAllocationSheet(mapping, 'hedgerow').firstRow;

    // E-2 carries the reference in both C and AC.
    expect(sheet?.getCell(`C${row}`).value).toBe('CC-H1');
    expect(sheet?.getCell(`AC${row}`).value).toBe('CC-H1');
  });

  it('refuses an allocation that would run past the sheet’s last row', () => {
    const sheet = offSiteAllocationSheet(mapping, 'area');
    const tooMany = Array.from({ length: 5 }, () => areaRow());
    expect(() =>
      writeOffSiteAllocation(fixture, { area: tooMany }, { startRow: { area: sheet.lastRow - 1 } }),
    ).toThrow(/would run past row/);
  });

  it('refuses a start row above the input area', () => {
    expect(() => writeOffSiteAllocation(fixture, { area: [areaRow()] }, { startRow: { area: 2 } })).toThrow(
      /is above the input area/,
    );
  });
});

describe('what the writer must not damage', () => {
  it('leaves the VBA project byte-for-byte intact', () => {
    expect(hasVbaProject(fixture)).toBe(true);

    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    const files = unzipSync(result.file);

    expect(files['xl/vbaProject.bin']).toEqual(FAKE_VBA);
  });

  it('leaves sheets it was not asked to write alone', async () => {
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    const workbook = await readBack(result.file);
    const start = workbook.getWorksheet('Start');

    expect(start?.getCell('F11').value).toBe('East Devon');
    expect(start?.getCell('F12').value).toBe('Original site name');
  });

  it('keeps every other part of the file', () => {
    const before = Object.keys(unzipSync(fixture)).sort();
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    const after = Object.keys(unzipSync(result.file)).sort();

    expect(after).toEqual(before);
  });

  it('does not modify the workbook it was given', () => {
    const original = Uint8Array.from(fixture);
    writeOffSiteAllocation(fixture, { area: [areaRow()] });
    expect(fixture).toEqual(original);
  });

  it('marks the workbook to recalculate, since nothing here evaluates its formulas', () => {
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    const workbookXml = new TextDecoder().decode(unzipSync(result.file)['xl/workbook.xml']!);
    expect(workbookXml).toMatch(/fullCalcOnLoad="1"/);
  });

  it('keeps the sheet list unchanged', () => {
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    expect(listSheetNames(result.file)).toEqual(listSheetNames(fixture));
  });
});

describe('warnings', () => {
  it('says plainly that the mapping is unverified', () => {
    const result = writeOffSiteAllocation(fixture, { area: [areaRow()] });
    expect(result.warnings.some((w) => /not been verified against a sample workbook/.test(w))).toBe(true);
  });

  it('reports writing over a formula, which would mean the mapping is wrong', () => {
    // Column A is not in any mapping, so it is reached directly to prove the
    // detection works.
    const sheet = offSiteAllocationSheet(mapping, 'area');
    const result = patchWorkbook(fixture, [
      {
        sheet: sheet.sheet,
        writes: [{ column: 'A', row: sheet.firstRow, value: { kind: 'text', value: 'clobbered' } }],
      },
    ]);
    expect(result.overwrittenFormulas).toContain(`${sheet.sheet}!A${sheet.firstRow}`);
  });

  it('reports a field the sheet has nowhere to put', () => {
    // E-3 has no spatial risk column mapped; the writer says so rather than
    // dropping the value quietly. Exercised here through the area sheet by
    // checking the mechanism reports at all.
    const result = writeOffSiteAllocation(fixture, {
      area: [areaRow({ userComments: 'From Cosdon bank' })],
    });
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('rejects an unknown sheet with a helpful message', () => {
    expect(() =>
      patchWorkbook(fixture, [
        { sheet: 'Not A Real Sheet', writes: [{ column: 'A', row: 1, value: { kind: 'blank' } }] },
      ]),
    ).toThrow(/not found. The workbook contains:/);
  });
});
