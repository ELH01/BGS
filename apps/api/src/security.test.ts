import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, loadDbConfig, resetDatabase } from '@bgs/db';
import { buildServer } from './server.js';

/**
 * The protections around the commercially sensitive parts of this system.
 *
 * Tenant isolation itself is proven in packages/db (rls-coverage.test.ts),
 * from the database catalogue rather than a list. This file covers everything
 * around it.
 */

let app: FastifyInstance;
let cookie = '';

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
  const setCookie = response.headers['set-cookie'];
  if (setCookie) {
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    cookie = String(raw).split(';')[0] ?? '';
  }
  return response;
}

let quoteId: string;

beforeAll(async () => {
  await resetDatabase(loadDbConfig().migrationUrl);
  app = await buildServer();
  await app.ready();

  await call('POST', '/api/auth/signup', {
    organisationName: 'Security Org',
    slug: 'security-org',
    email: 'security@example.test',
    password: 'a-sufficiently-long-password',
    displayName: 'Owner',
  });

  const operator = await call('POST', '/api/bank-operators', { name: 'Sec Banks' });
  const site = await call('POST', '/api/sites', {
    bankOperatorId: operator.json().bankOperator.id,
    name: 'Sec Site',
  });
  const developer = await call('POST', '/api/developers', { purchasingEntityName: 'Sec Developer' });

  await call('POST', '/api/stock-parcels', {
    siteId: site.json().site.id,
    parcelReference: 'SEC-1',
    module: 'area',
    broadHabitat: 'Grassland',
    habitatType: 'Other neutral grassland',
    distinctiveness: 'medium',
    totalUnits: '10.0',
    listPricePerUnit: '20000.00',
  });

  const quote = await call('POST', '/api/quotes', {
    developerId: developer.json().developer.id,
    bankOperatorId: operator.json().bankOperator.id,
    targets: [{ module: 'area', source: 'manual', requiredUnits: '5.0' }],
  });
  quoteId = quote.json().quote.id;
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe('responses carrying quotes and allocations are never cached', () => {
  it('marks every API response no-store', async () => {
    for (const url of ['/api/quotes', `/api/quotes/${quoteId}`, '/api/stock-pool', '/api/auth/me']) {
      const response = await call('GET', url);
      expect(response.headers['cache-control'], `${url} was cacheable`).toContain('no-store');
      expect(response.headers['cache-control']).toContain('private');
    }
  });

  it('marks the generated quote document no-store too', async () => {
    await call('PUT', `/api/quotes/${quoteId}/allocation`, { lines: [] });
    const response = await call('GET', `/api/quotes/${quoteId}/document-preview`);
    expect(response.headers['cache-control']).toContain('no-store');
  });
});

describe('security headers', () => {
  it('forbids framing, so the app cannot be clickjacked', async () => {
    const response = await call('GET', '/api/auth/me');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('does not leak URLs to third parties through the referrer', async () => {
    const response = await call('GET', '/api/auth/me');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('stops browsers second-guessing content types', async () => {
    const response = await call('GET', '/api/auth/me');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('cross-site request forgery', () => {
  it('rejects a state-changing request from another origin', async () => {
    const response = await call(
      'POST',
      '/api/quotes',
      { developerId: '00000000-0000-0000-0000-000000000000', bankOperatorId: '00000000-0000-0000-0000-000000000000', targets: [] },
      { origin: 'https://evil.example' },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/unrecognised origin/);
  });

  it('allows one from the configured front end', async () => {
    const response = await call('GET', '/api/quotes', undefined, { origin: 'http://localhost:5173' });
    expect(response.statusCode).toBe(200);
  });

  it('does not block reads, which carry no forgery risk', async () => {
    const response = await call('GET', '/api/quotes', undefined, { origin: 'https://evil.example' });
    expect(response.statusCode).toBe(200);
  });

  it('sets the session cookie httpOnly and same-site, so script cannot read it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'security@example.test', password: 'a-sufficiently-long-password' },
    });
    const raw = String(response.headers['set-cookie']);
    expect(raw).toContain('HttpOnly');
    expect(raw).toMatch(/SameSite=Lax/i);
  });
});

describe('what error responses give away', () => {
  it('does not echo Postgres’s own constraint text, which names the failing row', async () => {
    const site = await call('GET', '/api/sites');
    // 200 years in advance passes the request schema and is rejected by the
    // database, so this exercises the constraint path rather than validation.
    const response = await call('POST', '/api/stock-parcels', {
      siteId: site.json().sites[0].id,
      parcelReference: 'BAD-YEARS',
      module: 'area',
      broadHabitat: 'Grassland',
      habitatType: 'Other neutral grassland',
      distinctiveness: 'medium',
      totalUnits: '1.0',
      habitatCreatedInAdvanceYears: '200',
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error;
    expect(message).toBe('Years must be between 0 and 100.');
    // None of Postgres's own vocabulary should reach the caller.
    expect(message).not.toMatch(/relation|constraint|Failing row|stock_parcel/i);
  });

  it('still passes through the rules this codebase wrote for people to read', async () => {
    // Draft to reserved is refused by the status-ladder trigger, whose message
    // is written for a person and should arrive intact.
    const response = await call('POST', `/api/quotes/${quoteId}/status`, { status: 'reserved' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/draft quote can only become quoted or cancelled/i);
  });

  it('gives nothing away about which accounts exist', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'security@example.test', password: 'wrong-password-entirely' },
    });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.test', password: 'wrong-password-entirely' },
    });

    expect(wrongPassword.statusCode).toBe(noSuchUser.statusCode);
    expect(wrongPassword.body).toBe(noSuchUser.body);
  });

  it('answers a quote belonging to someone else with 404, not 403', async () => {
    // 403 would confirm the id exists. 404 says nothing either way.
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: {
        organisationName: 'Other Org',
        slug: 'other-org',
        email: 'other@example.test',
        password: 'a-sufficiently-long-password',
        displayName: 'Owner',
      },
    });
    const otherCookie = String(other.headers['set-cookie']).split(';')[0];

    const response = await app.inject({
      method: 'GET',
      url: `/api/quotes/${quoteId}`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('brute force', () => {
  it('rate limits repeated login attempts', async () => {
    // Its own server, with its own tight limits, so this test proves the
    // limiter without every other suite having to live under it.
    process.env['AUTH_RATE_LIMIT_MAX'] = '3';
    process.env['AUTH_RATE_LIMIT_WINDOW'] = '1 minute';
    const limited = await buildServer();
    await limited.ready();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await limited.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'security@example.test', password: `guess-${attempt}` },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    // And it is a clean 429, not a server error.
    expect(statuses).not.toContain(500);

    await limited.close();
    process.env['AUTH_RATE_LIMIT_MAX'] = '10000';
  });
});

describe('sessions', () => {
  it('stops working the moment it is revoked', async () => {
    const client = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'security@example.test', password: 'a-sufficiently-long-password' },
    });
    const sessionCookie = String(client.headers['set-cookie']).split(';')[0];

    const before = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie } });
    expect(before.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: sessionCookie } });

    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sessionCookie } });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a made-up session token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: 'bgs_session=not-a-real-token-at-all' },
    });
    expect(response.statusCode).toBe(401);
  });
});
