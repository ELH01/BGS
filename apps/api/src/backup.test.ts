import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

let app: FastifyInstance;

class Client {
  #cookie = '';
  constructor(private readonly instance: FastifyInstance) {}
  async raw(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
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
    return response;
  }
  async json(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    const response = await this.raw(method, url, payload);
    return { status: response.statusCode, body: response.json() as any };
  }
}

let cosdon: Client;
let rival: Client;

async function signUp(name: string, slug: string, email: string): Promise<Client> {
  const client = new Client(app);
  const response = await client.json('POST', '/api/auth/signup', {
    organisationName: name,
    slug,
    email,
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });
  expect(response.status).toBe(201);
  return client;
}

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  // The first organisation on an instance is the one running it; a later one
  // is a client operator with an account.
  cosdon = await signUp('Cosdon Consulting', 'cosdon', 'cosdon@example.test');
  rival = await signUp('Rival Banks', 'rival', 'rival@example.test');

  const operator = await cosdon.json('POST', '/api/bank-operators', { name: 'Cosdon Banks' });
  const site = await cosdon.json('POST', '/api/sites', {
    bankOperatorId: operator.body.bankOperator.id,
    name: 'Home Farm',
  });
  await cosdon.json('POST', '/api/stock-parcels', {
    siteId: site.body.site.id,
    parcelReference: 'F1',
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    totalUnits: '12.3457',
    listPricePerUnit: '25000.00',
  });

  const rivalOperator = await rival.json('POST', '/api/bank-operators', { name: 'Rival Banks Ltd' });
  const rivalSite = await rival.json('POST', '/api/sites', {
    bankOperatorId: rivalOperator.body.bankOperator.id,
    name: 'Rival Farm',
  });
  await rival.json('POST', '/api/stock-parcels', {
    siteId: rivalSite.body.site.id,
    parcelReference: 'RIVAL-SECRET',
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    totalUnits: '99.0',
    listPricePerUnit: '99000.00',
  });
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('organisation export (§4.8)', () => {
  it('contains this organisation’s own data', async () => {
    const response = await cosdon.raw('GET', '/api/backup/organisation');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/cosdon-export-.*\.json/);

    const data = JSON.parse(response.payload);
    expect(data.format).toBe('bgs-organisation-export');
    expect(data.organisation.slug).toBe('cosdon');
    expect(data.tables.stock_parcel).toHaveLength(1);
    expect(data.tables.stock_parcel[0].parcel_reference).toBe('F1');
  });

  it('cannot reach another organisation’s data', async () => {
    const response = await cosdon.raw('GET', '/api/backup/organisation');
    // The whole payload, not merely the parcel table: nothing of Rival's
    // should appear anywhere in a Cosdon export.
    expect(response.payload).not.toContain('RIVAL-SECRET');
    expect(response.payload).not.toContain('99000.00');
  });

  it('gives each organisation only its own', async () => {
    const response = await rival.raw('GET', '/api/backup/organisation');
    const data = JSON.parse(response.payload);
    expect(data.organisation.slug).toBe('rival');
    expect(data.tables.stock_parcel[0].parcel_reference).toBe('RIVAL-SECRET');
    expect(response.payload).not.toContain('F1');
  });

  it('writes quantities as text, so precision survives the round trip', async () => {
    const response = await cosdon.raw('GET', '/api/backup/organisation');
    const data = JSON.parse(response.payload);
    const parcel = data.tables.stock_parcel[0];

    expect(typeof parcel.total_units).toBe('string');
    expect(parcel.total_units).toBe('12.345700');
    expect(typeof parcel.list_price_per_unit).toBe('string');
  });

  it('reports a row count per table', async () => {
    const response = await cosdon.raw('GET', '/api/backup/organisation');
    const data = JSON.parse(response.payload);
    expect(data.counts.stock_parcel).toBe(1);
    expect(data.counts.bank_operator).toBe(1);
  });

  it('is available to any signed-in user', async () => {
    expect((await rival.raw('GET', '/api/backup/organisation')).statusCode).toBe(200);
  });

  it('refuses anonymous access', async () => {
    const anonymous = new Client(app);
    expect((await anonymous.raw('GET', '/api/backup/organisation')).statusCode).toBe(401);
  });
});

describe('whole-instance backup', () => {
  it('is refused to an operator who does not run the platform', async () => {
    const response = await rival.json('GET', '/api/backup/database');
    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/whoever runs this platform/);
  });

  it('is allowed to the platform operator', async () => {
    const response = await cosdon.raw('GET', '/api/backup/database');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/bgs-backup-.*\.dump/);
    // Postgres custom-format dumps begin with the magic "PGDMP".
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('PGDMP');
  });
});

describe('who runs the instance', () => {
  it('makes the first organisation the platform operator', async () => {
    const me = await cosdon.json('GET', '/api/auth/me');
    expect(me.body.organisation.isPlatformOperator).toBe(true);
  });

  it('does not make a later organisation one', async () => {
    const me = await rival.json('GET', '/api/auth/me');
    expect(me.body.organisation.isPlatformOperator).toBe(false);
  });
});

describe('backup status', () => {
  it('tells a client operator that instance backups are not theirs to take', async () => {
    const response = await rival.json('GET', '/api/backup/status');
    expect(response.body.organisationExport.available).toBe(true);
    expect(response.body.databaseBackup.allowed).toBe(false);
  });

  it('offers the instance backup to the platform operator', async () => {
    const response = await cosdon.json('GET', '/api/backup/status');
    expect(response.body.databaseBackup.allowed).toBe(true);
  });

  it('says plainly that restore is not done over HTTP, and how it is done', async () => {
    const response = await cosdon.json('GET', '/api/backup/status');
    expect(response.body.restore.viaHttp).toBe(false);
    expect(response.body.restore.instructions).toMatch(/pnpm db:restore/);
    expect(response.body.restore.instructions).toMatch(/cannot be undone/);
  });
});
