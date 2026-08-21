import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

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

let developerId: string;
let nearSiteId: string;
let farSiteId: string;

async function addParcel(siteId: string, reference: string, over: Record<string, unknown> = {}) {
  const response = await call('POST', '/api/stock-parcels', {
    siteId,
    parcelReference: reference,
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    condition: 'moderate',
    totalUnits: '10.0',
    listPricePerUnit: '20000.00',
    ...over,
  });
  expect(response.status).toBe(201);
  return response.body.stockParcel.id;
}

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  await call('POST', '/api/auth/signup', {
    organisationName: 'Solver Org',
    slug: 'solver-org',
    email: 'solver@example.test',
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });

  const operator = await call('POST', '/api/bank-operators', { name: 'Solver Banks' });

  const near = await call('POST', '/api/sites', {
    bankOperatorId: operator.body.bankOperator.id,
    name: 'Near Farm',
    lpaCode: 'E07000040',
    ncaCode: 'NCA148',
  });
  nearSiteId = near.body.site.id;

  const far = await call('POST', '/api/sites', {
    bankOperatorId: operator.body.bankOperator.id,
    name: 'Far Farm',
    lpaCode: 'E07000099',
    ncaCode: 'NCA999',
  });
  farSiteId = far.body.site.id;

  const developer = await call('POST', '/api/developers', {
    purchasingEntityName: 'Persimmon Homes',
    developmentLpaCode: 'E07000040',
    developmentNcaCode: 'NCA148',
  });
  developerId = developer.body.developer.id;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

const solve = (over: Record<string, unknown> = {}) =>
  call('POST', '/api/allocation-options', {
    module: 'area',
    requiredUnits: '5.0',
    developerId,
    shortfall: {
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
    },
    ...over,
  });

describe('the solver endpoint (§4.3)', () => {
  it('classifies a bank in the development’s own LPA as same-LPA', async () => {
    await addParcel(nearSiteId, 'NEAR-1');
    const response = await solve();

    expect(response.status).toBe(200);
    const option = response.body.options.find((o: any) => o.parcelReference === 'NEAR-1');
    expect(option.spatialBand).toBe('same-lpa');
    expect(option.rawUnitsPerEffectiveUnit).toBe('1');
  });

  it('classifies a distant bank as outside, and doubles the raw units it needs', async () => {
    await addParcel(farSiteId, 'FAR-1');
    const response = await solve();

    const option = response.body.options.find((o: any) => o.parcelReference === 'FAR-1');
    expect(option.spatialBand).toBe('outside');
    expect(option.rawUnitsPerEffectiveUnit).toBe('2');
    // £20,000 a unit but two units needed per effective one.
    expect(option.effectiveCostPerUnit).toBe('40000.00');
  });

  it('suggests a split that clears the target', async () => {
    const response = await solve();
    // No buffer configured, so the target is the stated shortfall itself.
    expect(response.body.bufferedTargetUnits).toBe('5.0000');
    expect(response.body.shortOfTarget).toBe(false);
    expect(Number(response.body.suggestedEffectiveUnits)).toBeGreaterThanOrEqual(5);
  });

  it('prefers the near parcel, being cheaper per effective unit', async () => {
    const response = await solve();
    expect(response.body.suggested[0].stockParcelId).toBe(
      response.body.options.find((o: any) => o.parcelReference === 'NEAR-1').stockParcelId,
    );
  });

  it('hands back every eligible option, not only the ones it used (§4.3.5)', async () => {
    const response = await solve();
    expect(response.body.options.length).toBeGreaterThan(response.body.suggested.length);
  });

  it('says what it rejected and why, so a missing parcel is explained', async () => {
    await addParcel(nearSiteId, 'TOO-LOW', { distinctiveness: 'low' });
    const response = await solve();

    const rejected = response.body.rejected.find((r: any) => r.parcelReference === 'TOO-LOW');
    expect(rejected.reason).toMatch(/below the Medium minimum/);
    expect(response.body.options.some((o: any) => o.parcelReference === 'TOO-LOW')).toBe(false);
  });

  it('honours the neighbouring-LPA band when adjacency is supplied', async () => {
    const response = await solve({ neighbouringLpas: ['E07000099'] });
    const option = response.body.options.find((o: any) => o.parcelReference === 'FAR-1');
    // Still outside, because the NCA differs too.
    expect(option.spatialBand).toBe('outside');
  });

  it('scopes to one site when asked (§4.3.1)', async () => {
    const response = await solve({ siteId: nearSiteId });
    expect(response.body.options.every((o: any) => o.siteId === nearSiteId)).toBe(true);
  });

  it('reports being short when eligible stock cannot cover the target', async () => {
    const response = await solve({ requiredUnits: '500.0' });
    expect(response.body.shortOfTarget).toBe(true);
    expect(Number(response.body.unmetUnits)).toBeGreaterThan(0);
  });

  it('never offers stock from another module', async () => {
    await addParcel(nearSiteId, 'HEDGE-1', {
      module: 'hedgerow',
      broadHabitat: 'Hedgerow',
      habitatType: 'Native hedgerow',
    });
    const response = await solve();
    expect(response.body.options.some((o: any) => o.parcelReference === 'HEDGE-1')).toBe(false);
  });

  it('flags that the spatial scheme is unconfirmed', async () => {
    const response = await solve();
    expect(response.body.spatialScheme.status).toBe('unconfirmed');
  });

  it('changes nothing — it proposes only', async () => {
    const before = await call('GET', '/api/stock-pool');
    await solve();
    const after = await call('GET', '/api/stock-pool');
    expect(after.body).toEqual(before.body);
  });

  it('requires a developer, since the multiplier depends on where the site is', async () => {
    const response = await solve({ developerId: '00000000-0000-0000-0000-000000000000' });
    expect(response.status).toBe(404);
  });

  it('refuses anonymous access', async () => {
    const saved = cookie;
    cookie = '';
    const response = await solve();
    cookie = saved;
    expect(response.status).toBe(401);
  });
});
