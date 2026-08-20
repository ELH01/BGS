import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

let app: FastifyInstance;

class Client {
  #cookie = '';
  constructor(private readonly instance: FastifyInstance) {}

  async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
    const response = await this.instance.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: this.#cookie ? { cookie: this.#cookie } : {},
    });
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      this.#cookie = String(raw).split(';')[0] ?? '';
    }
    return { status: response.statusCode, body: response.json() as any };
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, payload?: unknown) => this.request('POST', url, payload);
  put = (url: string, payload?: unknown) => this.request('PUT', url, payload);
  patch = (url: string, payload?: unknown) => this.request('PATCH', url, payload);
}

let client: Client;
let siteId: string;
let developerId: string;
let counter = 0;

/** A parcel with 10 area units available, near the development. */
async function makeParcel(units = '10.0'): Promise<string> {
  counter += 1;
  const response = await client.post('/api/stock-parcels', {
    siteId,
    parcelReference: `P${counter}`,
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    condition: 'moderate',
    totalUnits: units,
    listPricePerUnit: '20000.00',
  });
  expect(response.status).toBe(201);
  return response.body.stockParcel.id;
}

/** A draft quote needing `required` area units. */
async function makeQuote(required = '5.0'): Promise<string> {
  const response = await client.post('/api/quotes', {
    developerId,
    targets: [{ module: 'area', source: 'manual', requiredUnits: required }],
  });
  expect(response.status).toBe(201);
  return response.body.quote.id;
}

async function allocate(quoteId: string, parcelId: string, quantity: string) {
  return client.put(`/api/quotes/${quoteId}/allocation`, {
    lines: [
      {
        stockParcelId: parcelId,
        module: 'area',
        rawQuantity: quantity,
        spatialBand: 'same-lpa',
        unitPrice: '20000.00',
        tradingRuleJustification: 'Same broad habitat at equal distinctiveness.',
      },
    ],
  });
}

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  client = new Client(app);
  await client.post('/api/auth/signup', {
    organisationName: 'Quote Test Org',
    slug: 'quote-test',
    quoteReferencePrefix: 'CC',
    email: 'quotes@example.test',
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });

  const operator = await client.post('/api/bank-operators', { name: 'Test Banks' });
  const site = await client.post('/api/sites', {
    bankOperatorId: operator.body.bankOperator.id,
    name: 'Test Site',
    lpaCode: 'E07000040',
    ncaCode: 'NCA148',
  });
  siteId = site.body.site.id;

  const developer = await client.post('/api/developers', {
    purchasingEntityName: 'Barratt Homes plc',
    billingAddress: 'Registered office, London',
    developmentSiteAddress: 'Land north of Exeter',
  });
  developerId = developer.body.developer.id;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('quote creation (§3.7, §4.4)', () => {
  it('issues a human-readable reference from the organisation’s own series', async () => {
    const response = await client.post('/api/quotes', {
      developerId,
      targets: [{ module: 'area', source: 'manual', requiredUnits: '5.0' }],
    });
    expect(response.status).toBe(201);
    expect(response.body.quote.reference).toMatch(/^CC-\d{4}$/);
    expect(response.body.quote.status).toBe('draft');
  });

  it('applies the buffer above the shortfall, not exactly on it (§4.3.4)', async () => {
    const quoteId = await makeQuote('10.0');
    const response = await client.get(`/api/quotes/${quoteId}/targets`);
    const target = response.body.targets[0];

    expect(target.requiredUnits).toBe('10.0000');
    expect(target.bufferedTargetUnits).toBe('10.0100');
  });

  it('accepts a manual entry path with no metric import (§4.4)', async () => {
    const quoteId = await makeQuote('3.0');
    const response = await client.get(`/api/quotes/${quoteId}`);
    expect(response.body.quote.developerMetricId).toBeNull();
    expect(response.body.quote.targets[0].source).toBe('manual');
  });

  it('records creation in the audit log (§3.10)', async () => {
    const quoteId = await makeQuote();
    const response = await client.get(`/api/quotes/${quoteId}`);
    expect(response.body.audit.some((entry: any) => entry.action === 'created')).toBe(true);
  });
});

describe('the hard target gate (§4.4)', () => {
  let quoteId: string;
  let parcelId: string;

  beforeEach(async () => {
    quoteId = await makeQuote('5.0');
    parcelId = await makeParcel('20.0');
  });

  it('saves an allocation below target, so a table can be parked mid-edit', async () => {
    const response = await allocate(quoteId, parcelId, '2.0');
    expect(response.status).toBe(200);
    expect(response.body.targetStatus[0].meetsTarget).toBe(false);
    expect(response.body.targetStatus[0].shortBy).toBe('3.0050');
  });

  it('refuses to issue a quote while a module sits below its target', async () => {
    await allocate(quoteId, parcelId, '2.0');
    const response = await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/cannot be issued yet/);
    expect(response.body.error).toMatch(/3\.0050 units below/);
  });

  it('issues the quote once the target is cleared', async () => {
    await allocate(quoteId, parcelId, '5.005');
    const response = await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });

    expect(response.status).toBe(200);
    expect(response.body.quote.status).toBe('quoted');
  });

  it('will not let an exactly-10% allocation through when the buffer needs more', async () => {
    // 5.0000 is the bare shortfall; the buffered target is 5.0050.
    await allocate(quoteId, parcelId, '5.0');
    const response = await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    expect(response.status).toBe(409);
  });

  it('accounts for the multiplier when judging delivery', async () => {
    // The same raw quantity from a distant parcel delivers half as much.
    await client.put(`/api/quotes/${quoteId}/allocation`, {
      lines: [
        {
          stockParcelId: parcelId,
          module: 'area',
          rawQuantity: '5.005',
          spatialBand: 'outside',
          unitPrice: '20000.00',
        },
      ],
    });
    const response = await client.get(`/api/quotes/${quoteId}/targets`);
    expect(response.body.targets[0].deliveredUnits).toBe('2.5025');
    expect(response.body.targets[0].meetsTarget).toBe(false);
  });
});

describe('exposure semantics (§3.4, §4.4)', () => {
  it('a quoted allocation exposes units without reducing availability', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });

    const pool = await client.get('/api/stock-pool');
    const entry = pool.body.pool.find((p: any) => p.stockParcelId === parcelId);
    expect(entry.quotedUnits).toBe('5.0050');
    expect(entry.availableUnits).toBe('20.0000');
  });

  it('a reservation reduces availability', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'reserved' });

    const pool = await client.get('/api/stock-pool');
    const entry = pool.body.pool.find((p: any) => p.stockParcelId === parcelId);
    expect(entry.reservedUnits).toBe('5.0050');
    expect(entry.availableUnits).toBe('14.9950');
  });

  it('refuses a reservation that exceeds what is actually available', async () => {
    const parcelId = await makeParcel('6.0');

    const firstQuote = await makeQuote('5.0');
    await allocate(firstQuote, parcelId, '5.005');
    await client.post(`/api/quotes/${firstQuote}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${firstQuote}/status`, { status: 'reserved' });

    const secondQuote = await makeQuote('5.0');
    await allocate(secondQuote, parcelId, '5.005');
    await client.post(`/api/quotes/${secondQuote}/status`, { status: 'quoted' });
    const response = await client.post(`/api/quotes/${secondQuote}/status`, { status: 'reserved' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/cannot exceed what is available/);
  });

  it('allows two quotes to be over-quoted against the same parcel', async () => {
    const parcelId = await makeParcel('6.0');
    for (const _ of [1, 2]) {
      const quoteId = await makeQuote('5.0');
      await allocate(quoteId, parcelId, '5.005');
      const response = await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
      expect(response.status).toBe(200);
    }

    const pool = await client.get('/api/stock-pool');
    const entry = pool.body.pool.find((p: any) => p.stockParcelId === parcelId);
    expect(entry.isOverExposed).toBe(true);
    expect(entry.availableUnits).toBe('6.0000');
  });

  it('cancelling releases exposure entirely', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'cancelled', reason: 'Developer went elsewhere.' });

    const pool = await client.get('/api/stock-pool');
    const entry = pool.body.pool.find((p: any) => p.stockParcelId === parcelId);
    expect(entry.exposedUnits).toBe('0.0000');
  });

  it('demands a reason when cancelling', async () => {
    const quoteId = await makeQuote();
    const response = await client.post(`/api/quotes/${quoteId}/status`, { status: 'cancelled' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/reason/);
  });

  it('keeps a cancelled quote rather than deleting it, so history survives (§3.7)', async () => {
    const quoteId = await makeQuote();
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'cancelled', reason: 'Lost the deal.' });

    const response = await client.get(`/api/quotes/${quoteId}`);
    expect(response.status).toBe(200);
    expect(response.body.quote.status).toBe('cancelled');
    expect(response.body.quote.cancellationReason).toBe('Lost the deal.');
  });

  it('will not reopen a cancelled quote', async () => {
    const quoteId = await makeQuote();
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'cancelled', reason: 'Done.' });
    const response = await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/cancelled quotes are terminal/i);
  });
});

describe('editing rules by status (§4.4)', () => {
  it('edits a quoted allocation with no audit friction', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });

    const before = await client.get(`/api/quotes/${quoteId}`);
    const auditBefore = before.body.audit.length;

    await allocate(quoteId, parcelId, '6.0');
    const after = await client.get(`/api/quotes/${quoteId}`);

    expect(after.body.quote.lines[0].rawQuantity).toBe('6.0000');
    expect(after.body.audit.length).toBe(auditBefore);
  });

  it('records every edit to a reserved allocation, being a firmer commitment', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'reserved' });

    await allocate(quoteId, parcelId, '7.0');
    const response = await client.get(`/api/quotes/${quoteId}`);
    const entry = response.body.audit.find((a: any) => a.action === 'allocation-edited-while-reserved');

    expect(entry).toBeDefined();
    expect(entry.detail.before[0].rawQuantity).toBe('5.0050');
    expect(entry.detail.after[0].rawQuantity).toBe('7.0000');
  });

  it('refuses to edit a sold allocation, pointing at the reversal instead (§4.6)', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'reserved' });
    await client.post(`/api/quotes/${quoteId}/status`, {
      status: 'sold',
      soldDate: '2026-08-20',
      planningApplicationReference: '26/1234/FUL',
    });

    const response = await allocate(quoteId, parcelId, '9.0');
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/Reverse the sale/);
  });
});

describe('pricing (§3.8)', () => {
  it('computes each line total and the quote total from stored figures', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '2.3457');

    const response = await client.get(`/api/quotes/${quoteId}`);
    // 2.3457 units at £20,000 each.
    expect(response.body.quote.lines[0].lineTotal).toBe('46914.00');
    expect(response.body.quote.totalPrice).toBe('46914.00');
  });

  it('keeps the negotiated price per line rather than forcing the list price', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await client.put(`/api/quotes/${quoteId}/allocation`, {
      lines: [
        {
          stockParcelId: parcelId,
          module: 'area',
          rawQuantity: '2.0',
          spatialBand: 'same-lpa',
          unitPrice: '17500.00',
        },
      ],
    });

    const response = await client.get(`/api/quotes/${quoteId}`);
    expect(response.body.quote.lines[0].unitPrice).toBe('17500.00');
    expect(response.body.quote.totalPrice).toBe('35000.00');
  });
});

describe('sale and retirement (§4.6)', () => {
  let parcelId: string;
  let quoteId: string;

  beforeEach(async () => {
    parcelId = await makeParcel('5.0');
    quoteId = await makeQuote('2.0');
    await allocate(quoteId, parcelId, '2.3');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'reserved' });
  });

  it('retires the allocated units, leaving the remainder at full precision', async () => {
    const response = await client.post(`/api/quotes/${quoteId}/status`, {
      status: 'sold',
      soldDate: '2026-08-20',
      planningApplicationReference: '26/1234/FUL',
    });
    expect(response.status).toBe(200);

    const pool = await client.get('/api/stock-pool');
    const entry = pool.body.pool.find((p: any) => p.stockParcelId === parcelId);
    // The specification's own worked example: 5.0000 less 2.3000.
    expect(entry.soldUnits).toBe('2.3000');
    expect(entry.availableUnits).toBe('2.7000');
  });

  it('records the planning reference and the sale date', async () => {
    await client.post(`/api/quotes/${quoteId}/status`, {
      status: 'sold',
      soldDate: '2026-08-20',
      planningApplicationReference: '26/1234/FUL',
    });

    const response = await client.get(`/api/quotes/${quoteId}`);
    expect(response.body.sale.planningApplicationReference).toBe('26/1234/FUL');
    expect(response.body.sale.soldDate).toContain('2026-08-20');
  });

  it('takes the register submission date later, once it is known (§3.9)', async () => {
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'sold', soldDate: '2026-08-20' });

    const before = await client.get(`/api/quotes/${quoteId}`);
    expect(before.body.sale.bgsRegisterSubmissionDate).toBeNull();

    await client.patch(`/api/quotes/${quoteId}`, { bgsRegisterSubmissionDate: '2026-09-01' });
    const after = await client.get(`/api/quotes/${quoteId}`);
    expect(after.body.sale.bgsRegisterSubmissionDate).toContain('2026-09-01');
  });

  it('needs a sale date', async () => {
    const response = await client.post(`/api/quotes/${quoteId}/status`, { status: 'sold' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/date it completed/);
  });

  it('refuses to sell a quote with no allocation', async () => {
    const empty = await makeQuote('1.0');
    await client.put(`/api/quotes/${empty}/allocation`, { lines: [] });
    const response = await client.post(`/api/quotes/${empty}/status`, { status: 'sold', soldDate: '2026-08-20' });
    expect(response.status).toBe(409);
  });
});

describe('reversing a sale (§4.6.6)', () => {
  let parcelId: string;
  let quoteId: string;

  beforeEach(async () => {
    parcelId = await makeParcel('5.0');
    quoteId = await makeQuote('2.0');
    await allocate(quoteId, parcelId, '2.3');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'reserved' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'sold', soldDate: '2026-08-20' });
  });

  it('restores the exact quantities that were retired', async () => {
    const response = await client.post(`/api/quotes/${quoteId}/reverse-sale`, {
      reason: 'Deal fell through after exchange.',
      moveTo: 'reserved',
    });
    expect(response.status).toBe(200);

    const pool = await client.get('/api/stock-pool');
    const entry = pool.body.pool.find((p: any) => p.stockParcelId === parcelId);
    expect(entry.soldUnits).toBe('0.0000');
    expect(entry.totalUnits).toBe('5.0000');
  });

  it('moves the quote where the user chose', async () => {
    await client.post(`/api/quotes/${quoteId}/reverse-sale`, {
      reason: 'Developer withdrew.',
      moveTo: 'cancelled',
    });
    const response = await client.get(`/api/quotes/${quoteId}`);
    expect(response.body.quote.status).toBe('cancelled');
  });

  it('demands a reason', async () => {
    const response = await client.post(`/api/quotes/${quoteId}/reverse-sale`, { moveTo: 'reserved' });
    expect(response.status).toBe(400);
  });

  it('logs the full reversal', async () => {
    await client.post(`/api/quotes/${quoteId}/reverse-sale`, {
      reason: 'Contract rescinded.',
      moveTo: 'reserved',
    });

    const response = await client.get(`/api/quotes/${quoteId}`);
    const entry = response.body.audit.find((a: any) => a.action === 'sale-reversed');
    expect(entry.note).toBe('Contract rescinded.');
    expect(entry.fromStatus).toBe('sold');
    expect(entry.detail.restored).toHaveLength(1);
  });

  it('refuses to reverse a quote that was never sold', async () => {
    const other = await makeQuote('1.0');
    const response = await client.post(`/api/quotes/${other}/reverse-sale`, {
      reason: 'Nothing to reverse.',
      moveTo: 'reserved',
    });
    expect(response.status).toBe(409);
  });

  it('will not reverse the same sale twice', async () => {
    await client.post(`/api/quotes/${quoteId}/reverse-sale`, { reason: 'First.', moveTo: 'reserved' });
    const response = await client.post(`/api/quotes/${quoteId}/reverse-sale`, {
      reason: 'Second.',
      moveTo: 'reserved',
    });
    expect(response.status).toBe(409);
  });
});

describe('status ladder', () => {
  it('refuses to jump from draft straight to sold', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');

    const response = await client.post(`/api/quotes/${quoteId}/status`, {
      status: 'sold',
      soldDate: '2026-08-20',
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/draft quote can only become quoted or cancelled/i);
  });

  it('records every transition with both statuses (§3.10)', async () => {
    const parcelId = await makeParcel('20.0');
    const quoteId = await makeQuote('5.0');
    await allocate(quoteId, parcelId, '5.005');
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'quoted' });
    await client.post(`/api/quotes/${quoteId}/status`, { status: 'reserved' });

    const response = await client.get(`/api/quotes/${quoteId}`);
    const transitions = response.body.audit
      .filter((a: any) => a.action === 'status-changed')
      .map((a: any) => `${a.fromStatus}->${a.toStatus}`);

    expect(transitions).toContain('draft->quoted');
    expect(transitions).toContain('quoted->reserved');
  });
});

describe('quote listing', () => {
  it('lists quotes with the purchaser and the stale threshold in force', async () => {
    const response = await client.get('/api/quotes');
    expect(response.status).toBe(200);
    expect(response.body.staleAfterDays).toBe(60);
    expect(response.body.quotes[0].developerName).toBe('Barratt Homes plc');
  });

  it('does not mark a fresh quote as stale', async () => {
    const quoteId = await makeQuote();
    const response = await client.get(`/api/quotes/${quoteId}`);
    expect(response.body.quote.isStale).toBe(false);
  });

  it('filters by status', async () => {
    const response = await client.get('/api/quotes?status=cancelled');
    expect(response.body.quotes.every((q: any) => q.status === 'cancelled')).toBe(true);
  });
});
