import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from './client.js';
import { getStockUnitPool } from './repositories.js';
import {
  ensureTestSchema,
  seedOrganisation,
  seedParcel,
  seedQuoteWithAllocation,
  teardown,
  type SeededOrg,
} from './test-support.js';

let org: SeededOrg;

beforeAll(async () => {
  await ensureTestSchema();
  org = await seedOrganisation('Pool Test');
});

afterAll(teardown);

async function poolFor(parcelId: string) {
  const pool = await withTenant(org.organisationId, (tx) => getStockUnitPool(tx));
  const entry = pool.find((p) => p.stockParcelId === parcelId);
  if (!entry) throw new Error('Parcel missing from pool view.');
  return entry;
}

describe('stock unit pool invariants (§3.4)', () => {
  it('starts with everything available and nothing exposed', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-1', units: '10.0' }),
    );
    const entry = await poolFor(parcel.id);

    expect(entry.totalUnits.toString()).toBe('10.0000');
    expect(entry.availableUnits.toString()).toBe('10.0000');
    expect(entry.exposedUnits.toString()).toBe('0.0000');
    expect(entry.isOverExposed).toBe(false);
  });

  it('a quote is soft: it exposes units but does NOT reduce availability', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-2', units: '10.0' }),
    );
    await withTenant(org.organisationId, (tx) =>
      seedQuoteWithAllocation(tx, org, {
        parcelId: parcel.id,
        module: 'area',
        quantity: '4.0',
        status: 'quoted',
      }),
    );

    const entry = await poolFor(parcel.id);
    expect(entry.quotedUnits.toString()).toBe('4.0000');
    expect(entry.exposedUnits.toString()).toBe('4.0000');
    // The invariant that distinguishes this system from a naive one:
    expect(entry.availableUnits.toString()).toBe('10.0000');
  });

  it('a reservation is firm: it does reduce availability', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-3', units: '10.0' }),
    );
    await withTenant(org.organisationId, (tx) =>
      seedQuoteWithAllocation(tx, org, {
        parcelId: parcel.id,
        module: 'area',
        quantity: '4.0',
        status: 'reserved',
      }),
    );

    const entry = await poolFor(parcel.id);
    expect(entry.reservedUnits.toString()).toBe('4.0000');
    expect(entry.availableUnits.toString()).toBe('6.0000');
  });

  it('a cancelled quote releases its exposure entirely (§4.4)', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-4', units: '10.0' }),
    );
    await withTenant(org.organisationId, (tx) =>
      seedQuoteWithAllocation(tx, org, {
        parcelId: parcel.id,
        module: 'area',
        quantity: '4.0',
        status: 'cancelled',
      }),
    );

    const entry = await poolFor(parcel.id);
    expect(entry.exposedUnits.toString()).toBe('0.0000');
    expect(entry.availableUnits.toString()).toBe('10.0000');
  });

  it('a draft allocation is tracked separately and does not count as a quote', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-5', units: '10.0' }),
    );
    await withTenant(org.organisationId, (tx) =>
      seedQuoteWithAllocation(tx, org, {
        parcelId: parcel.id,
        module: 'area',
        quantity: '3.0',
        status: 'draft',
      }),
    );

    const entry = await poolFor(parcel.id);
    expect(entry.draftUnits.toString()).toBe('3.0000');
    expect(entry.quotedUnits.toString()).toBe('0.0000');
    expect(entry.exposedUnits.toString()).toBe('0.0000');
  });

  it('surfaces over-quoting rather than hiding or preventing it (§4.4)', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-6', units: '10.0' }),
    );
    for (const quantity of ['6.0', '7.0']) {
      await withTenant(org.organisationId, (tx) =>
        seedQuoteWithAllocation(tx, org, { parcelId: parcel.id, module: 'area', quantity, status: 'quoted' }),
      );
    }

    const entry = await poolFor(parcel.id);
    expect(entry.quotedUnits.toString()).toBe('13.0000');
    expect(entry.isOverExposed).toBe(true);
    // Over-quoting is permitted; availability is untouched because quotes are soft.
    expect(entry.availableUnits.toString()).toBe('10.0000');
  });

  it('partial retirement leaves the remainder available at full precision (§4.6)', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-7', units: '5.0' }),
    );
    await withTenant(org.organisationId, (tx) =>
      tx.query('UPDATE stock_parcel SET retired_units = $2 WHERE id = $1', [parcel.id, '2.3000']),
    );

    const entry = await poolFor(parcel.id);
    expect(entry.soldUnits.toString()).toBe('2.3000');
    expect(entry.availableUnits.toString()).toBe('2.7000');
  });

  it('reports each module at its own precision', async () => {
    const hedge = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-8', module: 'hedgerow', units: '7.5' }),
    );
    const water = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-9', module: 'watercourse', units: '3.25' }),
    );

    expect((await poolFor(hedge.id)).availableUnits.toString()).toBe('7.500');
    expect((await poolFor(water.id)).availableUnits.toString()).toBe('3.250');
  });

  it('accumulates many small allocations without drift', async () => {
    const parcel = await withTenant(org.organisationId, (tx) =>
      seedParcel(tx, org, { reference: 'POOL-10', units: '100.0' }),
    );
    for (let i = 0; i < 30; i += 1) {
      await withTenant(org.organisationId, (tx) =>
        seedQuoteWithAllocation(tx, org, {
          parcelId: parcel.id,
          module: 'area',
          quantity: '0.1111',
          status: 'reserved',
        }),
      );
    }

    const entry = await poolFor(parcel.id);
    expect(entry.reservedUnits.toString()).toBe('3.3330');
    expect(entry.availableUnits.toString()).toBe('96.6670');
  });
});
