import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

let app: FastifyInstance;

/** A signed-in browser: keeps whatever session cookie the server issued. */
class Client {
  #cookie = '';

  constructor(private readonly instance: FastifyInstance) {}

  async request(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: any }> {
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

    return { status: response.statusCode, body: response.json() };
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, payload?: unknown) => this.request('POST', url, payload);
  put = (url: string, payload?: unknown) => this.request('PUT', url, payload);
}

async function signUp(name: string, slug: string, email: string): Promise<Client> {
  const client = new Client(app);
  const response = await client.post('/api/auth/signup', {
    organisationName: name,
    slug,
    quoteReferencePrefix: 'TQ',
    email,
    password: 'a-sufficiently-long-password',
    displayName: `${name} Owner`,
  });
  expect(response.status).toBe(201);
  return client;
}

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('authentication', () => {
  it('creates an organisation and signs the owner in', async () => {
    const client = await signUp('Cosdon Consulting', 'cosdon', 'elliott@example.test');
    const me = await client.get('/api/auth/me');

    expect(me.status).toBe(200);
    expect(me.body.organisation.name).toBe('Cosdon Consulting');
    expect(me.body.user.role).toBe('owner');
    expect(me.body.accessibleOrganisations).toHaveLength(1);
  });

  it('refuses anonymous access to protected routes', async () => {
    const anonymous = new Client(app);
    expect((await anonymous.get('/api/auth/me')).status).toBe(401);
    expect((await anonymous.get('/api/bank-operators')).status).toBe(401);
    expect((await anonymous.get('/api/stock-pool')).status).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const client = new Client(app);
    const wrongPassword = await client.post('/api/auth/login', {
      email: 'elliott@example.test',
      password: 'not-the-right-password',
    });
    const unknownUser = await client.post('/api/auth/login', {
      email: 'nobody@example.test',
      password: 'not-the-right-password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownUser.body);
  });

  it('signs in with the right password and issues a working session', async () => {
    const client = new Client(app);
    const login = await client.post('/api/auth/login', {
      email: 'elliott@example.test',
      password: 'a-sufficiently-long-password',
    });
    expect(login.status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(200);
  });

  it('invalidates the session on logout', async () => {
    const client = new Client(app);
    await client.post('/api/auth/login', {
      email: 'elliott@example.test',
      password: 'a-sufficiently-long-password',
    });
    await client.post('/api/auth/logout');
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a short password at sign-up', async () => {
    const client = new Client(app);
    const response = await client.post('/api/auth/signup', {
      organisationName: 'Too Short',
      slug: 'too-short',
      email: 'short@example.test',
      password: 'brief',
      displayName: 'Owner',
    });
    expect(response.status).toBe(400);
    expect(response.body.issues[0].message).toMatch(/at least 12 characters/);
  });

  it('rejects a duplicate organisation slug', async () => {
    const client = new Client(app);
    const response = await client.post('/api/auth/signup', {
      organisationName: 'Cosdon Again',
      slug: 'cosdon',
      email: 'other@example.test',
      password: 'a-sufficiently-long-password',
      displayName: 'Owner',
    });
    expect(response.status).toBe(409);
  });
});

describe('bank operators, sites and stock', () => {
  let client: Client;
  let operatorId: string;
  let siteId: string;

  beforeAll(async () => {
    client = await signUp('Stock Test Org', 'stock-test', 'stock@example.test');

    const operator = await client.post('/api/bank-operators', {
      name: 'Cosdon Habitat Banks',
      contactEmail: 'banks@example.test',
      branding: { companyName: 'Cosdon Consulting Ltd', accentColour: '#2F5D3A' },
    });
    operatorId = operator.body.bankOperator.id;

    const site = await client.post('/api/sites', {
      bankOperatorId: operatorId,
      name: 'Home Farm',
      lpaCode: 'E07000040',
      ncaCode: 'NCA148',
      bgsRegisterReference: 'BGS-000123',
    });
    siteId = site.body.site.id;
  });

  it('stores branding against the operator, not globally (§3.1)', async () => {
    const response = await client.get(`/api/bank-operators/${operatorId}`);
    expect(response.body.bankOperator.branding.companyName).toBe('Cosdon Consulting Ltd');
    expect(response.body.bankOperator.branding.accentColour).toBe('#2F5D3A');
  });

  it('rejects a branding colour that is not a hex value', async () => {
    const response = await client.post('/api/bank-operators', {
      name: 'Bad Colour',
      branding: { accentColour: 'forest green' },
    });
    expect(response.status).toBe(400);
  });

  it('creates a stock parcel and returns units at the module’s precision', async () => {
    const response = await client.post('/api/stock-parcels', {
      siteId,
      parcelReference: 'F1',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      condition: 'moderate',
      totalUnits: '12.34567',
      listPricePerUnit: '25000.00',
    });

    expect(response.status).toBe(201);
    expect(response.body.stockParcel.totalUnits).toBe('12.3457');
    expect(response.body.stockParcel.listPricePerUnit).toBe('25000.00');
  });

  it('holds hedgerow units at three decimal places', async () => {
    const response = await client.post('/api/stock-parcels', {
      siteId,
      parcelReference: 'H1',
      module: 'hedgerow',
      broadHabitat: 'Hedgerow',
      habitatType: 'Native hedgerow',
      distinctiveness: 'medium',
      totalUnits: '4.5678',
    });
    expect(response.body.stockParcel.totalUnits).toBe('4.568');
  });

  it('refuses a unit quantity sent as a JSON number rather than a string', async () => {
    // A numeric literal has already been through a double by the time it
    // arrives, so the API will not accept one for a quantity.
    const response = await client.post('/api/stock-parcels', {
      siteId,
      parcelReference: 'NUM',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      totalUnits: 12.3457,
    });
    expect(response.status).toBe(400);
  });

  it('refuses text that is not a decimal', async () => {
    const response = await client.post('/api/stock-parcels', {
      siteId,
      parcelReference: 'TXT',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      totalUnits: 'about ten',
    });
    expect(response.status).toBe(400);
  });

  it('rejects a duplicate parcel reference within a site and module', async () => {
    const duplicate = {
      siteId,
      parcelReference: 'F1',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      totalUnits: '1.0',
    };
    expect((await client.post('/api/stock-parcels', duplicate)).status).toBe(409);
  });

  it('serialises every quantity and price as a string, never a JSON number', async () => {
    const response = await client.get('/api/stock-parcels');
    for (const parcel of response.body.stockParcels) {
      expect(typeof parcel.totalUnits).toBe('string');
      expect(typeof parcel.retiredUnits).toBe('string');
      if (parcel.listPricePerUnit !== null) expect(typeof parcel.listPricePerUnit).toBe('string');
    }
  });

  it('sets the list price after import (§3.3)', async () => {
    const parcels = await client.get('/api/stock-parcels?module=hedgerow');
    const parcelId = parcels.body.stockParcels[0].id;

    const response = await client.put(`/api/stock-parcels/${parcelId}/list-price`, {
      listPricePerUnit: '12500.50',
    });
    expect(response.status).toBe(200);
    expect(response.body.stockParcel.listPricePerUnit).toBe('12500.50');
  });

  it('reports the unit pool with everything available and nothing exposed', async () => {
    const response = await client.get('/api/stock-pool');
    const entry = response.body.pool.find((p: any) => p.parcelReference === 'F1');

    expect(entry.availableUnits).toBe('12.3457');
    expect(entry.exposedUnits).toBe('0.0000');
    expect(entry.isOverExposed).toBe(false);
  });

  it('filters the pool by module', async () => {
    const response = await client.get('/api/stock-pool?module=hedgerow');
    expect(response.body.pool.every((p: any) => p.module === 'hedgerow')).toBe(true);
  });

  it('rejects an unknown module', async () => {
    expect((await client.get('/api/stock-pool?module=woodland')).status).toBe(400);
  });
});

describe('tenant isolation over HTTP', () => {
  it('does not let one organisation see or reach another’s data', async () => {
    const alpha = await signUp('Alpha Banks', 'alpha-banks', 'alpha@example.test');
    const beta = await signUp('Beta Banks', 'beta-banks', 'beta@example.test');

    const operator = await alpha.post('/api/bank-operators', { name: 'Alpha Operator' });
    const alphaOperatorId = operator.body.bankOperator.id;
    await alpha.post('/api/sites', { bankOperatorId: alphaOperatorId, name: 'Alpha Site' });

    // Beta sees only its own (empty) world.
    expect((await beta.get('/api/bank-operators')).body.bankOperators).toHaveLength(0);
    expect((await beta.get('/api/sites')).body.sites).toHaveLength(0);

    // And cannot reach Alpha's operator even knowing its id exactly.
    expect((await beta.get(`/api/bank-operators/${alphaOperatorId}`)).status).toBe(404);
    expect((await beta.put(`/api/bank-operators/${alphaOperatorId}`, { name: 'Hijacked' })).status).toBe(404);

    // Alpha's record is untouched.
    expect((await alpha.get(`/api/bank-operators/${alphaOperatorId}`)).body.bankOperator.name).toBe(
      'Alpha Operator',
    );
  });

  it('refuses an attempt to file a record under another organisation', async () => {
    const gamma = await signUp('Gamma Banks', 'gamma-banks', 'gamma@example.test');
    const delta = await signUp('Delta Banks', 'delta-banks', 'delta@example.test');

    const deltaOrgId = (await delta.get('/api/auth/me')).body.organisation.id;
    const response = await gamma.post('/api/bank-operators', {
      organisationId: deltaOrgId,
      name: 'Planted by Gamma',
    });

    expect(response.status).toBe(403);
    expect((await delta.get('/api/bank-operators')).body.bankOperators).toHaveLength(0);
  });
});

describe('configuration reporting (§5)', () => {
  it('reports the spatial risk scheme as unconfirmed rather than presenting it as authoritative', async () => {
    const client = await signUp('Config Org', 'config-org', 'config@example.test');
    const response = await client.get('/api/config');

    expect(response.body.spatialRisk.status).toBe('unconfirmed');
    expect(response.body.tradingRules.status).toBe('unconfirmed');
    expect(response.body.netGain.bufferConfirmed).toBe(false);
    expect(response.body.quotes.staleThresholdConfirmed).toBe(false);
  });

  it('reports each module’s decimal places', async () => {
    const client = await signUp('Config Two', 'config-two', 'config2@example.test');
    const modules = (await client.get('/api/config')).body.modules;

    expect(modules).toEqual([
      { id: 'area', label: 'Area habitat', decimalPlaces: 4 },
      { id: 'hedgerow', label: 'Hedgerow', decimalPlaces: 3 },
      { id: 'watercourse', label: 'Watercourse', decimalPlaces: 3 },
    ]);
  });
});

describe('metric inputs on a stock parcel', () => {
  let client: Client;
  let siteId: string;

  beforeAll(async () => {
    client = await signUp('Metric Inputs Org', 'metric-inputs', 'metric@example.test');
    const operator = await client.post('/api/bank-operators', { name: 'Inputs Banks' });
    const site = await client.post('/api/sites', {
      bankOperatorId: operator.body.bankOperator.id,
      name: 'Inputs Site',
    });
    siteId = site.body.site.id;
  });

  const newParcel = (over: Record<string, unknown> = {}) => ({
    siteId,
    parcelReference: `IN-${Math.random().toString(36).slice(2, 8)}`,
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    condition: 'moderate',
    totalUnits: '11.7285',
    ...over,
  });

  it('reports what a parcel still needs before it can reach a developer’s metric', async () => {
    const response = await client.post('/api/stock-parcels', newParcel());
    expect(response.status).toBe(201);

    const readiness = response.body.stockParcel.exportReadiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain('strategic significance');
    expect(readiness.missing).toContain('physical extent (hectares or kilometres)');
  });

  it('accepts every metric input at creation and reports the parcel complete', async () => {
    const response = await client.post(
      '/api/stock-parcels',
      newParcel({
        extent: '5.0',
        strategicSignificance: 'formally-identified',
        habitatCreatedInAdvanceYears: '3',
        delayYears: '0',
      }),
    );

    expect(response.status).toBe(201);
    expect(response.body.stockParcel.extent).toBe('5.000000');
    expect(response.body.stockParcel.strategicSignificance).toBe('formally-identified');
    expect(response.body.stockParcel.exportReadiness.ready).toBe(true);
  });

  it('fills the inputs in later, since they often arrive after the parcel', async () => {
    const created = await client.post('/api/stock-parcels', newParcel());
    const parcelId = created.body.stockParcel.id;

    const response = await client.put(`/api/stock-parcels/${parcelId}/metric-inputs`, {
      extent: '4.5',
      strategicSignificance: 'ecologically-desirable',
      habitatCreatedInAdvanceYears: '2.5',
      delayYears: '0',
    });

    expect(response.status).toBe(200);
    expect(response.body.stockParcel.exportReadiness.ready).toBe(true);
    expect(response.body.stockParcel.habitatCreatedInAdvanceYears).toBe('2.50');
  });

  it('rejects a strategic significance the metric does not have', async () => {
    const response = await client.post('/api/stock-parcels', newParcel({ strategicSignificance: 'very-important' }));
    expect(response.status).toBe(400);
  });

  it('rejects years that are not a number', async () => {
    const response = await client.post(
      '/api/stock-parcels',
      newParcel({ habitatCreatedInAdvanceYears: 'about three' }),
    );
    expect(response.status).toBe(400);
  });

  it('keeps extent out of the unit precision system', async () => {
    // Extent is a physical measurement, not a biodiversity unit quantity, so
    // it is not held at the module's 4dp scale.
    const response = await client.post('/api/stock-parcels', newParcel({ extent: '5.123456' }));
    expect(response.body.stockParcel.extent).toBe('5.123456');
    expect(response.body.stockParcel.totalUnits).toBe('11.7285');
  });
});
