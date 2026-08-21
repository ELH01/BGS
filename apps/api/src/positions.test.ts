import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

/**
 * The position export: what is quoted, reserved and sold, as a spreadsheet.
 */

let app: FastifyInstance;
let cookie = '';

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: cookie ? { cookie } : {},
  });
  const setCookie = response.headers['set-cookie'];
  if (setCookie) {
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = String(raw).split(';')[0] ?? '';
  }
  return response;
}

const json = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const response = await call(method, url, payload);
  return { status: response.statusCode, body: response.json() as any };
};

async function readWorkbook(payload: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(payload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

let cosdonOperatorId: string;
let otherOperatorId: string;

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  await json('POST', '/api/auth/signup', {
    organisationName: 'Cosdon Consulting',
    slug: 'cosdon',
    quoteReferencePrefix: 'CC',
    email: 'positions@example.test',
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });

  const cosdon = await json('POST', '/api/bank-operators', { name: 'Cosdon Habitat Banks' });
  cosdonOperatorId = cosdon.body.bankOperator.id;
  const other = await json('POST', '/api/bank-operators', { name: 'Client Bank Ltd' });
  otherOperatorId = other.body.bankOperator.id;

  const site = await json('POST', '/api/sites', {
    bankOperatorId: cosdonOperatorId,
    name: 'Home Farm',
    lpaCode: 'E07000040',
    ncaCode: 'NCA148',
  });
  const otherSite = await json('POST', '/api/sites', {
    bankOperatorId: otherOperatorId,
    name: 'Client Farm',
    lpaCode: 'E07000040',
    ncaCode: 'NCA148',
  });

  const parcel = await json('POST', '/api/stock-parcels', {
    siteId: site.body.site.id,
    parcelReference: 'F1',
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    condition: 'moderate',
    totalUnits: '20.0',
    listPricePerUnit: '20000.00',
  });
  await json('POST', '/api/stock-parcels', {
    siteId: otherSite.body.site.id,
    parcelReference: 'C1',
    module: 'hedgerow',
    broadHabitat: 'Hedgerow',
    habitatType: 'Native hedgerow',
    distinctiveness: 'medium',
    totalUnits: '8.0',
    listPricePerUnit: '9000.00',
  });

  const developer = await json('POST', '/api/developers', {
    purchasingEntityName: 'Barratt Homes plc',
    developmentSiteAddress: 'Land north of Exeter',
  });

  // One reserved quote and one still in draft, so both sides of the status
  // filter have something to find.
  const reserved = await json('POST', '/api/quotes', {
    developerId: developer.body.developer.id,
    bankOperatorId: cosdonOperatorId,
    targets: [{ module: 'area', source: 'manual', requiredUnits: '5.0' }],
  });
  await json('PUT', `/api/quotes/${reserved.body.quote.id}/allocation`, {
    lines: [
      {
        stockParcelId: parcel.body.stockParcel.id,
        module: 'area',
        rawQuantity: '5.005',
        spatialBand: 'same-lpa',
        unitPrice: '20000.00',
      },
    ],
  });
  await json('POST', `/api/quotes/${reserved.body.quote.id}/status`, { status: 'quoted' });
  await json('POST', `/api/quotes/${reserved.body.quote.id}/status`, { status: 'reserved' });

  const draft = await json('POST', '/api/quotes', {
    developerId: developer.body.developer.id,
    bankOperatorId: cosdonOperatorId,
    targets: [{ module: 'area', source: 'manual', requiredUnits: '2.0' }],
  });
  await json('PUT', `/api/quotes/${draft.body.quote.id}/allocation`, {
    lines: [
      {
        stockParcelId: parcel.body.stockParcel.id,
        module: 'area',
        rawQuantity: '2.002',
        spatialBand: 'same-lpa',
        unitPrice: '18000.00',
      },
    ],
  });
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('the position export', () => {
  it('downloads as a spreadsheet with a dated filename', async () => {
    const response = await call('GET', '/api/positions/export');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml');
    expect(String(response.headers['content-disposition'])).toMatch(
      /attachment; filename="Positions-\d{4}-\d{2}-\d{2}\.xlsx"/,
    );
  });

  it('carries a sheet for each question being asked of it', async () => {
    const response = await call('GET', '/api/positions/export');
    const workbook = await readWorkbook(response.rawPayload);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'About',
      'Allocations',
      'Quotes',
      'Stock position',
    ]);
  });

  it('explains itself on the cover sheet, so a saved file is not a mystery later', async () => {
    const response = await call('GET', '/api/positions/export');
    const workbook = await readWorkbook(response.rawPayload);
    const cover = workbook.getWorksheet('About');

    const text = (cover?.getSheetValues() ?? []).flat().filter(Boolean).join(' ');
    expect(text).toContain('Quoted, reserved and sold positions');
    expect(text).toContain('Cosdon Consulting');
    expect(text).toContain('All banks');
  });

  it('lists one row per allocation line, with both unit figures', async () => {
    const response = await call('GET', '/api/positions/export');
    const workbook = await readWorkbook(response.rawPayload);
    const sheet = workbook.getWorksheet('Allocations')!;

    const headers = sheet.getRow(1).values as string[];
    expect(headers).toContain('Units drawn');
    expect(headers).toContain('Units delivered');
    expect(headers).toContain('Line total');

    // Two allocations were made: the reserved quote and the draft.
    expect(sheet.rowCount - 1).toBe(2);
  });

  it('writes quantities as numbers at the module’s own precision', async () => {
    const response = await call('GET', '/api/positions/export');
    const workbook = await readWorkbook(response.rawPayload);
    const sheet = workbook.getWorksheet('Allocations')!;

    const headers = sheet.getRow(1).values as string[];
    const unitsColumn = headers.indexOf('Units drawn');
    const cell = sheet.getRow(2).getCell(unitsColumn);

    expect(typeof cell.value).toBe('number');
    expect(cell.value).toBeCloseTo(5.005, 4);
    // Area units show four decimal places, as they do everywhere else.
    expect(cell.numFmt).toBe('0.0000');
  });

  it('shows the stock position per parcel, including what is left', async () => {
    const response = await call('GET', '/api/positions/export');
    const workbook = await readWorkbook(response.rawPayload);
    const sheet = workbook.getWorksheet('Stock position')!;
    const headers = sheet.getRow(1).values as string[];

    expect(headers).toContain('Available');
    expect(headers).toContain('Over-quoted');

    // Rows are ordered by bank name, so find the parcel rather than assume a
    // position.
    const parcelColumn = headers.indexOf('Parcel');
    let available: number | null = null;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(parcelColumn).value === 'F1') {
        available = row.getCell(headers.indexOf('Available')).value as number;
      }
    });

    // 20 total less the 5.005 reserved; the draft does not reduce it.
    expect(available).toBeCloseTo(14.995, 4);
  });

  it('gives each quote its total with and without VAT', async () => {
    const response = await call('GET', '/api/positions/export');
    const workbook = await readWorkbook(response.rawPayload);
    const sheet = workbook.getWorksheet('Quotes')!;
    const headers = sheet.getRow(1).values as string[];

    expect(headers).toContain('Total excluding VAT');
    expect(headers).toContain('VAT');
    expect(headers).toContain('Total including VAT');

    const net = sheet.getRow(2).getCell(headers.indexOf('Total excluding VAT')).value as number;
    const vat = sheet.getRow(2).getCell(headers.indexOf('VAT')).value as number;
    const gross = sheet.getRow(2).getCell(headers.indexOf('Total including VAT')).value as number;
    expect(vat).toBeCloseTo(net * 0.2, 2);
    expect(gross).toBeCloseTo(net + vat, 2);
  });

  it('leaves cancelled quotes out by default', async () => {
    const summary = await json('GET', '/api/positions/summary');
    expect(summary.body.defaultStatuses).toEqual(['draft', 'quoted', 'reserved', 'sold']);
  });

  it('narrows to the statuses asked for', async () => {
    const response = await call('GET', '/api/positions/export?statuses=reserved');
    const workbook = await readWorkbook(response.rawPayload);

    // Only the reserved quote's line survives the filter.
    expect(workbook.getWorksheet('Allocations')!.rowCount - 1).toBe(1);
    expect(workbook.getWorksheet('Quotes')!.rowCount - 1).toBe(1);
  });

  it('narrows to one bank, and says so on the cover', async () => {
    const response = await call('GET', `/api/positions/export?bankOperatorId=${otherOperatorId}`);
    const workbook = await readWorkbook(response.rawPayload);

    const cover = (workbook.getWorksheet('About')?.getSheetValues() ?? []).flat().filter(Boolean).join(' ');
    expect(cover).toContain('Client Bank Ltd');

    // That bank has stock but no quotes against it.
    expect(workbook.getWorksheet('Allocations')!.rowCount - 1).toBe(0);
    expect(workbook.getWorksheet('Stock position')!.rowCount - 1).toBe(1);
  });

  it('names the filename after the bank when narrowed', async () => {
    const response = await call('GET', `/api/positions/export?bankOperatorId=${cosdonOperatorId}`);
    expect(String(response.headers['content-disposition'])).toContain('Positions-Cosdon-Habitat-Banks-');
  });

  it('rejects an unrecognised status rather than quietly returning everything', async () => {
    const response = await json('GET', '/api/positions/export?statuses=pending');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Statuses must be from/);
  });

  it('404s on a bank that is not visible, rather than returning an empty book', async () => {
    const response = await json(
      'GET',
      '/api/positions/export?bankOperatorId=00000000-0000-0000-0000-000000000000',
    );
    expect(response.status).toBe(404);
  });

  it('summarises what the export would hold', async () => {
    const summary = await json('GET', '/api/positions/summary');
    expect(summary.body.allocationLines).toBe(2);
    expect(summary.body.quotes).toBe(2);
    expect(summary.body.parcels).toBe(2);
  });

  it('refuses anonymous access, since this is the whole commercial picture', async () => {
    const saved = cookie;
    cookie = '';
    const response = await call('GET', '/api/positions/export');
    cookie = saved;
    expect(response.statusCode).toBe(401);
  });

  it('never carries another organisation’s figures', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        organisationName: 'Rival Consulting',
        slug: 'rival',
        email: 'rival@example.test',
        password: 'a-sufficiently-long-password',
        displayName: 'Owner',
      },
    });
    const otherCookie = String(other.headers['set-cookie']).split(';')[0];

    const response = await app.inject({
      method: 'GET',
      url: '/api/positions/export',
      headers: { cookie: otherCookie },
    });
    const workbook = await readWorkbook(response.rawPayload);

    expect(workbook.getWorksheet('Allocations')!.rowCount - 1).toBe(0);
    expect(workbook.getWorksheet('Stock position')!.rowCount - 1).toBe(0);
  });
});
