import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

/**
 * Running several habitat banks from one account.
 *
 * A bank operator holds sites; sites hold parcels. Someone with more than one
 * bank thinks in banks first, so exposure has to be reachable that way and not
 * only site by site.
 */

let app: FastifyInstance;
let cookie = '';

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
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
  return { status: response.statusCode, body: response.json() as any };
}

const banks: Record<string, { operatorId: string; siteId: string }> = {};

async function makeBank(name: string, siteName: string) {
  const operator = await call('POST', '/api/bank-operators', { name });
  const site = await call('POST', '/api/sites', {
    bankOperatorId: operator.body.bankOperator.id,
    name: siteName,
    lpaCode: 'E07000040',
    ncaCode: 'NCA148',
  });
  banks[name] = { operatorId: operator.body.bankOperator.id, siteId: site.body.site.id };
}

async function addParcel(siteId: string, reference: string, units: string) {
  return call('POST', '/api/stock-parcels', {
    siteId,
    parcelReference: reference,
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    totalUnits: units,
    listPricePerUnit: '20000.00',
  });
}

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  await call('POST', '/api/auth/signup', {
    organisationName: 'Cosdon Consulting',
    slug: 'cosdon',
    email: 'multi@example.test',
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });

  await makeBank('Dartmoor Bank', 'Home Farm');
  await makeBank('Exe Valley Bank', 'Riverside');

  await addParcel(banks['Dartmoor Bank']!.siteId, 'DART-1', '10.0');
  await addParcel(banks['Dartmoor Bank']!.siteId, 'DART-2', '6.0');
  await addParcel(banks['Exe Valley Bank']!.siteId, 'EXE-1', '8.0');
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('several banks under one account', () => {
  it('shows every bank’s stock together by default', async () => {
    const response = await call('GET', '/api/stock-pool');
    expect(response.body.pool).toHaveLength(3);
    expect(response.body.banks).toHaveLength(2);
  });

  it('tells you which bank and site each parcel belongs to', async () => {
    const response = await call('GET', '/api/stock-pool');
    const dart = response.body.pool.find((entry: any) => entry.parcelReference === 'DART-1');

    expect(dart.bankOperatorName).toBe('Dartmoor Bank');
    expect(dart.siteName).toBe('Home Farm');
  });

  it('rolls up per bank, so you can see where each stands', async () => {
    const response = await call('GET', '/api/stock-pool');
    const rollUp = response.body.banks.find((bank: any) => bank.bankOperatorName === 'Dartmoor Bank');

    expect(rollUp.parcels).toBe(2);
    expect(rollUp.overExposed).toBe(0);
  });

  it('narrows to one bank', async () => {
    const response = await call(
      'GET',
      `/api/stock-pool?bankOperatorId=${banks['Exe Valley Bank']!.operatorId}`,
    );
    expect(response.body.pool).toHaveLength(1);
    expect(response.body.pool[0].parcelReference).toBe('EXE-1');
  });

  it('narrows stock parcels to one bank too', async () => {
    const response = await call(
      'GET',
      `/api/stock-parcels?bankOperatorId=${banks['Dartmoor Bank']!.operatorId}`,
    );
    expect(response.body.stockParcels.map((p: any) => p.parcelReference).sort()).toEqual([
      'DART-1',
      'DART-2',
    ]);
  });

  it('combines a bank filter with a module filter', async () => {
    const response = await call(
      'GET',
      `/api/stock-pool?bankOperatorId=${banks['Dartmoor Bank']!.operatorId}&module=hedgerow`,
    );
    expect(response.body.pool).toHaveLength(0);
  });

  it('flags a bank that has gone over-quoted, so it stands out among the others', async () => {
    const developer = await call('POST', '/api/developers', { purchasingEntityName: 'A Developer' });
    const parcels = await call(
      'GET',
      `/api/stock-parcels?bankOperatorId=${banks['Exe Valley Bank']!.operatorId}`,
    );
    const parcelId = parcels.body.stockParcels[0].id;

    for (const quantity of ['7.0', '6.0']) {
      const quote = await call('POST', '/api/quotes', {
        developerId: developer.body.developer.id,
        targets: [{ module: 'area', source: 'manual', requiredUnits: '5.0' }],
      });
      await app.inject({
        method: 'PUT',
        url: `/api/quotes/${quote.body.quote.id}/allocation`,
        headers: { cookie },
        payload: {
          lines: [
            {
              stockParcelId: parcelId,
              module: 'area',
              rawQuantity: quantity,
              spatialBand: 'same-lpa',
              unitPrice: '20000.00',
            },
          ],
        },
      });
      await call('POST', `/api/quotes/${quote.body.quote.id}/status`, { status: 'quoted' });
    }

    const response = await call('GET', '/api/stock-pool');
    const exe = response.body.banks.find((bank: any) => bank.bankOperatorName === 'Exe Valley Bank');
    const dartmoor = response.body.banks.find((bank: any) => bank.bankOperatorName === 'Dartmoor Bank');

    expect(exe.overExposed).toBe(1);
    expect(dartmoor.overExposed).toBe(0);
  });

  it('keeps the solver able to search across every bank at once', async () => {
    const developer = await call('POST', '/api/developers', {
      purchasingEntityName: 'Cross Bank Developer',
      developmentLpaCode: 'E07000040',
      developmentNcaCode: 'NCA148',
    });

    const response = await call('POST', '/api/allocation-options', {
      module: 'area',
      requiredUnits: '5.0',
      developerId: developer.body.developer.id,
    });

    const siteNames = new Set(response.body.options.map((option: any) => option.siteName));
    expect(siteNames.size).toBeGreaterThan(1);
  });
});
