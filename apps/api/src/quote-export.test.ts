import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { unzipSync } from 'fflate';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

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

let siteId: string;
let secondOperatorSiteId: string;
let developerId: string;
let quoteId: string;
let parcelId: string;

/** Visible text of a generated document, read back out of the .docx. */
function documentText(raw: Buffer): string {
  const files = unzipSync(new Uint8Array(raw));
  return new TextDecoder()
    .decode(files['word/document.xml']!)
    .replace(/<\/w:(p|tc)>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  await json('POST', '/api/auth/signup', {
    organisationName: 'Export Org',
    slug: 'export-org',
    quoteReferencePrefix: 'CC',
    email: 'export@example.test',
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });

  const operator = await json('POST', '/api/bank-operators', {
    name: 'Cosdon Habitat Banks',
    branding: {
      companyName: 'Cosdon Consulting Ltd',
      address: 'Unit 4, Example Park\nDevon\nEX1 1AA',
      contact: 'hello@cosdon.example',
      accentColour: '#2F5D3A',
    },
  });
  const site = await json('POST', '/api/sites', {
    bankOperatorId: operator.body.bankOperator.id,
    name: 'Home Farm',
    lpaCode: 'E07000040',
    ncaCode: 'NCA148',
  });
  siteId = site.body.site.id;

  const other = await json('POST', '/api/bank-operators', { name: 'Second Operator' });
  const otherSite = await json('POST', '/api/sites', {
    bankOperatorId: other.body.bankOperator.id,
    name: 'Other Farm',
    lpaCode: 'E07000040',
    ncaCode: 'NCA148',
  });
  secondOperatorSiteId = otherSite.body.site.id;

  const developer = await json('POST', '/api/developers', {
    purchasingEntityName: 'Barratt Homes plc',
    billingAddress: 'Registered Office\nLondon\nEC1A 1AA',
    developmentSiteAddress: 'Land north of Exeter',
    developmentLpaCode: 'E07000040',
    developmentNcaCode: 'NCA148',
    contactName: 'A Buyer',
    contactEmail: 'buyer@example.test',
  });
  developerId = developer.body.developer.id;

  const parcel = await json('POST', '/api/stock-parcels', {
    siteId,
    parcelReference: 'F1',
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    condition: 'moderate',
    totalUnits: '20.0',
    listPricePerUnit: '20000.00',
  });
  parcelId = parcel.body.stockParcel.id;

  const quote = await json('POST', '/api/quotes', {
    developerId,
    targets: [{ module: 'area', source: 'manual', requiredUnits: '5.0' }],
  });
  quoteId = quote.body.quote.id;

  await json('PUT', `/api/quotes/${quoteId}/allocation`, {
    lines: [
      {
        stockParcelId: parcelId,
        module: 'area',
        rawQuantity: '2.3457',
        spatialBand: 'same-lpa',
        unitPrice: '20000.00',
      },
    ],
  });
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('the quote document (§4.7)', () => {
  it('is served as a Word document with a reference-derived filename', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('wordprocessingml.document');
    expect(response.headers['content-disposition']).toContain('Quote-CC-0001.docx');
  });

  it('carries the bank operator’s branding, not the platform’s', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    const text = documentText(response.rawPayload);

    expect(text).toContain('Cosdon Consulting Ltd');
    expect(text).toContain('Unit 4, Example Park');
    expect(text).toContain('hello@cosdon.example');
  });

  it('addresses the purchaser at the billing address, never the development site', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    const text = documentText(response.rawPayload);

    expect(text).toContain('Barratt Homes plc');
    expect(text).toContain('Registered Office');
    // The development site drives the multiplier, not the invoice.
    expect(text).not.toContain('Land north of Exeter');
  });

  it('shows the line at the module’s precision with its habitat description', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    const text = documentText(response.rawPayload);

    expect(text).toContain('2.3457');
    expect(text).toContain('Other neutral grassland');
    expect(text).toContain('Medium distinctiveness');
    expect(text).toContain('£46,914.00');
  });

  it('shows the units required, so the purchaser can see the lines meet the need', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    const text = documentText(response.rawPayload);

    expect(text).toContain('Units required');
    expect(text).toContain('Area habitat: 5.0000 units');
  });

  it('prints the provisional-figures caveat on the document itself', async () => {
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    const text = documentText(response.rawPayload);

    expect(text).toContain('spatial risk multipliers');
    expect(text).toContain('VAT treatment is to be confirmed');
  });

  it('refuses to export a quote with no allocation', async () => {
    const empty = await json('POST', '/api/quotes', {
      developerId,
      targets: [{ module: 'area', source: 'manual', requiredUnits: '1.0' }],
    });
    const response = await json('GET', `/api/quotes/${empty.body.quote.id}/document`);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/nothing to quote for/);
  });

  it('exports a sold quote unchanged, since the document is the record', async () => {
    await json('POST', `/api/quotes/${quoteId}/status`, { status: 'quoted' });
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    expect(response.statusCode).toBe(200);
  });

  it('refuses anonymous access', async () => {
    const saved = cookie;
    cookie = '';
    const response = await call('GET', `/api/quotes/${quoteId}/document`);
    cookie = saved;
    expect(response.statusCode).toBe(401);
  });
});

describe('document preview warnings', () => {
  it('names the operator that will brand the document', async () => {
    const response = await json('GET', `/api/quotes/${quoteId}/document-preview`);
    expect(response.body.brandingOperator.name).toBe('Cosdon Habitat Banks');
    expect(response.body.operatorCount).toBe(1);
    expect(response.body.filename).toBe('Quote-CC-0001.docx');
  });

  it('warns when a quote spans more than one bank operator', async () => {
    const secondParcel = await json('POST', '/api/stock-parcels', {
      siteId: secondOperatorSiteId,
      parcelReference: 'S1',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      totalUnits: '10.0',
      listPricePerUnit: '15000.00',
    });

    const mixed = await json('POST', '/api/quotes', {
      developerId,
      targets: [{ module: 'area', source: 'manual', requiredUnits: '5.0' }],
    });
    await json('PUT', `/api/quotes/${mixed.body.quote.id}/allocation`, {
      lines: [
        {
          stockParcelId: parcelId,
          module: 'area',
          rawQuantity: '4.0',
          spatialBand: 'same-lpa',
          unitPrice: '20000.00',
        },
        {
          stockParcelId: secondParcel.body.stockParcel.id,
          module: 'area',
          rawQuantity: '1.5',
          spatialBand: 'same-lpa',
          unitPrice: '15000.00',
        },
      ],
    });

    const response = await json('GET', `/api/quotes/${mixed.body.quote.id}/document-preview`);
    expect(response.body.operatorCount).toBe(2);
    // Branded by whoever supplies the most units.
    expect(response.body.brandingOperator.name).toBe('Cosdon Habitat Banks');
    expect(response.body.warnings.some((w: string) => /draws on 2 bank operators/.test(w))).toBe(true);
  });

  it('warns when the branding operator has none set', async () => {
    const bare = await json('POST', '/api/quotes', {
      developerId,
      targets: [{ module: 'area', source: 'manual', requiredUnits: '1.0' }],
    });
    const parcel = await json('POST', '/api/stock-parcels', {
      siteId: secondOperatorSiteId,
      parcelReference: 'S2',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      totalUnits: '5.0',
      listPricePerUnit: '15000.00',
    });
    await json('PUT', `/api/quotes/${bare.body.quote.id}/allocation`, {
      lines: [
        {
          stockParcelId: parcel.body.stockParcel.id,
          module: 'area',
          rawQuantity: '1.0',
          spatialBand: 'same-lpa',
          unitPrice: '15000.00',
        },
      ],
    });

    const response = await json('GET', `/api/quotes/${bare.body.quote.id}/document-preview`);
    expect(response.body.warnings.some((w: string) => /no quote branding set/.test(w))).toBe(true);
  });

  it('reports VAT as unconfigured by default', async () => {
    const response = await json('GET', `/api/quotes/${quoteId}/document-preview`);
    expect(response.body.vat.treatment).toBe('none');
    expect(response.body.vat.status).toBe('unconfirmed');
  });
});
