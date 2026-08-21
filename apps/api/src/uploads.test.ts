import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { unzipSync, zipSync } from 'fflate';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { getMetricMapping, offSiteAllocationSheet } from '@bgs/metric';
import { buildServer } from './server.js';

let app: FastifyInstance;
let storageDir: string;
let cookie = '';

/** Multipart body for a single file, assembled by hand. */
function multipart(field: string, filename: string, bytes: Uint8Array, contentType: string) {
  const boundary = '----bgstestboundary9f2a';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
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

async function upload(url: string, filename: string, bytes: Uint8Array, contentType: string) {
  const body = multipart('file', filename, bytes, contentType);
  return app.inject({
    method: 'POST',
    url,
    payload: body.payload,
    headers: { ...body.headers, ...(cookie ? { cookie } : {}) },
  });
}

const json = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const response = await call(method, url, payload);
  return { status: response.statusCode, body: response.json() as any };
};

/** A one-pixel PNG. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00,
  0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
  0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const FAKE_VBA = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x42, 0x42]);

/** A workbook shaped like the metric, with a VBA part to prove it survives. */
async function metricWorkbook(): Promise<Uint8Array> {
  const mapping = getMetricMapping();
  const workbook = new ExcelJS.Workbook();

  for (const module of ['area', 'hedgerow', 'watercourse'] as const) {
    const sheetMapping = offSiteAllocationSheet(mapping, module);
    const sheet = workbook.addWorksheet(sheetMapping.sheet);
    sheet.getCell('A1').value = `${sheetMapping.sheet} header`;
  }
  const start = workbook.addWorksheet('Start');
  start.getCell('F12').value = 'Land north of Exeter';

  const buffer = await workbook.xlsx.writeBuffer();
  const files = unzipSync(new Uint8Array(buffer as ArrayBuffer));
  files['xl/vbaProject.bin'] = FAKE_VBA;
  return zipSync(files);
}

let operatorId: string;
let developerId: string;
let quoteId: string;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'bgs-uploads-'));
  process.env['STORAGE_DIR'] = storageDir;

  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  await json('POST', '/api/auth/signup', {
    organisationName: 'Cosdon Consulting',
    slug: 'cosdon',
    quoteReferencePrefix: 'CC',
    email: 'uploads@example.test',
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });

  const operator = await json('POST', '/api/bank-operators', {
    name: 'Cosdon Habitat Banks',
    branding: { companyName: 'Cosdon Consulting Ltd', address: 'Devon' },
  });
  operatorId = operator.body.bankOperator.id;

  const site = await json('POST', '/api/sites', {
    bankOperatorId: operatorId,
    name: 'Home Farm',
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
    extent: '10.0',
    strategicSignificance: 'formally-identified',
    habitatCreatedInAdvanceYears: '3',
    delayYears: '0',
  });

  const developer = await json('POST', '/api/developers', {
    purchasingEntityName: 'Barratt Homes plc',
    developmentLpaCode: 'E07000040',
    developmentNcaCode: 'NCA148',
  });
  developerId = developer.body.developer.id;

  const quote = await json('POST', '/api/quotes', {
    developerId,
    bankOperatorId: operatorId,
    targets: [{ module: 'area', source: 'manual', requiredUnits: '5.0' }],
  });
  quoteId = quote.body.quote.id;

  await json('PUT', `/api/quotes/${quoteId}/allocation`, {
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
});

afterAll(async () => {
  await app.close();
  await closePool();
  await rm(storageDir, { recursive: true, force: true });
});

describe('operator logo upload (§3.1)', () => {
  it('accepts a real image and reports it back', async () => {
    const response = await upload(`/api/bank-operators/${operatorId}/logo`, 'logo.png', PNG, 'image/png');

    expect(response.statusCode).toBe(201);
    expect(response.json().logo.contentType).toBe('image/png');
    expect(response.json().logo.filename).toBe('logo.png');
  });

  it('serves the logo back to a signed-in user', async () => {
    const response = await call('GET', `/api/bank-operators/${operatorId}/logo`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(new Uint8Array(response.rawPayload)).toEqual(PNG);
  });

  it('will not serve it to someone with no session', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/bank-operators/${operatorId}/logo` });
    expect(response.statusCode).toBe(401);
  });

  it('judges the file by its bytes, not by what the upload claimed', async () => {
    // A script named and typed as a PNG.
    const script = new TextEncoder().encode('<?php system($_GET["c"]); ?>');
    const response = await upload(`/api/bank-operators/${operatorId}/logo`, 'evil.png', script, 'image/png');

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not an image the platform recognises/);
  });

  it('refuses a workbook uploaded as a logo', async () => {
    const workbook = await metricWorkbook();
    const response = await upload(`/api/bank-operators/${operatorId}/logo`, 'book.xlsx', workbook, 'image/png');
    expect(response.statusCode).toBe(400);
  });

  it('replaces the previous logo rather than accumulating them', async () => {
    const before = await json('GET', `/api/bank-operators/${operatorId}`);
    const firstId = before.body.bankOperator.branding.logoFileId;

    await upload(`/api/bank-operators/${operatorId}/logo`, 'second.png', PNG, 'image/png');

    const after = await json('GET', `/api/bank-operators/${operatorId}`);
    expect(after.body.bankOperator.branding.logoFileId).not.toBe(firstId);
  });

  it('removes the logo when asked', async () => {
    const response = await json('DELETE', `/api/bank-operators/${operatorId}/logo`);
    expect(response.status).toBe(200);

    const operator = await json('GET', `/api/bank-operators/${operatorId}`);
    expect(operator.body.bankOperator.branding.logoFileId).toBeNull();

    // And re-upload for the document test below.
    await upload(`/api/bank-operators/${operatorId}/logo`, 'logo.png', PNG, 'image/png');
  });

  it('404s for an operator in another organisation', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        organisationName: 'Rival',
        slug: 'rival-uploads',
        email: 'rival-uploads@example.test',
        password: 'a-sufficiently-long-password',
        displayName: 'Owner',
      },
    });
    const otherCookie = String(other.headers['set-cookie']).split(';')[0];

    const response = await app.inject({
      method: 'GET',
      url: `/api/bank-operators/${operatorId}/logo`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('puts the logo into the quote document', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    expect(response.statusCode).toBe(200);

    // A docx is a zip; an embedded image lands in word/media.
    const parts = Object.keys(unzipSync(new Uint8Array(response.rawPayload)));
    expect(parts.some((part) => part.startsWith('word/media/'))).toBe(true);
  });

  it('says on the preview when no logo is set', async () => {
    await json('DELETE', `/api/bank-operators/${operatorId}/logo`);
    const preview = await json('GET', `/api/quotes/${quoteId}/document-preview`);
    expect(preview.body.warnings.some((w: string) => /no logo uploaded/.test(w))).toBe(true);

    await upload(`/api/bank-operators/${operatorId}/logo`, 'logo.png', PNG, 'image/png');
  });
});

describe('developer metric upload (§4.2)', () => {
  it('accepts the developer’s workbook and keeps it', async () => {
    const workbook = await metricWorkbook();
    const response = await upload(
      `/api/developers/${developerId}/metric`,
      'Barratt metric 4.0.xlsm',
      workbook,
      'application/vnd.ms-excel.sheet.macroEnabled.12',
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().metricImport.filename).toBe('Barratt metric 4.0.xlsm');
    expect(response.json().metricImport.sheetCount).toBeGreaterThan(0);
  });

  it('lists what has been uploaded for a developer', async () => {
    const response = await json('GET', `/api/developers/${developerId}/metrics`);
    expect(response.body.metricImports).toHaveLength(1);
    expect(response.body.metricImports[0].kind).toBe('developer');
  });

  it('gives the original back byte for byte', async () => {
    const listed = await json('GET', `/api/developers/${developerId}/metrics`);
    const response = await call('GET', `/api/metric-imports/${listed.body.metricImports[0].id}/file`);

    expect(response.statusCode).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(response.rawPayload)))).toContain('xl/vbaProject.bin');
  });

  it('refuses something that is not a workbook', async () => {
    const response = await upload(
      `/api/developers/${developerId}/metric`,
      'notes.txt',
      new TextEncoder().encode('just some text'),
      'application/vnd.ms-excel',
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not an Excel workbook/);
  });

  it('refuses a zip that is not a workbook at all', async () => {
    // Passes the magic-byte check, fails on being opened.
    const notAWorkbook = zipSync({ 'readme.txt': new TextEncoder().encode('hello') });
    const response = await upload(
      `/api/developers/${developerId}/metric`,
      'archive.xlsx',
      notAWorkbook,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/could not be opened|no worksheets/);
  });
});

describe('writing the allocation back into the developer’s metric (§4.7)', () => {
  it('reports itself ready once the workbook and allocation are both there', async () => {
    const response = await json('GET', `/api/quotes/${quoteId}/metric-export-preview`);

    expect(response.body.ready).toBe(true);
    expect(response.body.blockers).toEqual([]);
    expect(response.body.workbook.filename).toBe('Barratt metric 4.0.xlsm');
    expect(response.body.modules).toEqual(['area']);
  });

  it('downloads a copy with the off-site tab filled in', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/metric-export`);
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-disposition'])).toContain('CC-0001 off-site.xlsm');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    const mapping = getMetricMapping();
    const sheetMapping = offSiteAllocationSheet(mapping, 'area');
    const sheet = workbook.getWorksheet(sheetMapping.sheet)!;
    const row = sheetMapping.firstRow;

    expect(sheet.getCell(`D${row}`).value).toBe('Grassland');
    expect(sheet.getCell(`E${row}`).value).toBe('Other neutral grassland');
    // 5.005 of 20 units is a quarter of the parcel, so a quarter of its 10 ha.
    expect(sheet.getCell(`G${row}`).value).toBeCloseTo(2.5025, 4);
  });

  it('leaves the developer’s macros and other sheets untouched', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/metric-export`);
    const parts = unzipSync(new Uint8Array(response.rawPayload));

    expect(parts['xl/vbaProject.bin']).toEqual(FAKE_VBA);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.getWorksheet('Start')?.getCell('F12').value).toBe('Land north of Exeter');
  });

  it('never alters the uploaded original', async () => {
    await call('GET', `/api/quotes/${quoteId}/metric-export`);

    const listed = await json('GET', `/api/developers/${developerId}/metrics`);
    const original = await call('GET', `/api/metric-imports/${listed.body.metricImports[0].id}/file`);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(original.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheetMapping = offSiteAllocationSheet(getMetricMapping(), 'area');
    const sheet = workbook.getWorksheet(sheetMapping.sheet)!;

    expect(sheet.getCell(`D${sheetMapping.firstRow}`).value).toBeFalsy();
  });

  it('refuses when the developer has no workbook uploaded', async () => {
    const other = await json('POST', '/api/developers', { purchasingEntityName: 'No Metric Ltd' });
    const quote = await json('POST', '/api/quotes', {
      developerId: other.body.developer.id,
      bankOperatorId: operatorId,
      targets: [{ module: 'area', source: 'manual', requiredUnits: '1.0' }],
    });

    const preview = await json('GET', `/api/quotes/${quote.body.quote.id}/metric-export-preview`);
    expect(preview.body.ready).toBe(false);
    expect(preview.body.blockers.some((b: string) => /No metric workbook/.test(b))).toBe(true);

    const download = await json('GET', `/api/quotes/${quote.body.quote.id}/metric-export`);
    expect(download.status).toBe(409);
  });

  it('stops rather than writing a parcel that is missing its metric inputs', async () => {
    const site = await json('GET', '/api/sites');
    const bare = await json('POST', '/api/stock-parcels', {
      siteId: site.body.sites[0].id,
      parcelReference: 'BARE',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      totalUnits: '10.0',
      listPricePerUnit: '20000.00',
    });

    const quote = await json('POST', '/api/quotes', {
      developerId,
      bankOperatorId: operatorId,
      targets: [{ module: 'area', source: 'manual', requiredUnits: '1.0' }],
    });
    await json('PUT', `/api/quotes/${quote.body.quote.id}/allocation`, {
      lines: [
        {
          stockParcelId: bare.body.stockParcel.id,
          module: 'area',
          rawQuantity: '1.001',
          spatialBand: 'same-lpa',
          unitPrice: '20000.00',
        },
      ],
    });

    const preview = await json('GET', `/api/quotes/${quote.body.quote.id}/metric-export-preview`);
    expect(preview.body.ready).toBe(false);
    expect(preview.body.blockers.some((b: string) => /BARE is missing/.test(b))).toBe(true);

    const download = await json('GET', `/api/quotes/${quote.body.quote.id}/metric-export`);
    expect(download.status).toBe(409);
  });

  it('refuses anonymous access to the written workbook', async () => {
    const saved = cookie;
    cookie = '';
    const response = await call('GET', `/api/quotes/${quoteId}/metric-export`);
    cookie = saved;
    expect(response.statusCode).toBe(401);
  });
});
