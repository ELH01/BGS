import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitQuantity } from '@bgs/core';
import { withTenant } from './client.js';
import { createStockParcel, getStockParcel, listSites, listStockParcels } from './repositories.js';
import {
  ensureTestSchema,
  grantManagement,
  seedOrganisation,
  seedParcel,
  teardown,
  type SeededOrg,
} from './test-support.js';

let cosdon: SeededOrg;
let rival: SeededOrg;
let rivalParcelId: string;
let cosdonParcelId: string;

beforeAll(async () => {
  await ensureTestSchema();
  cosdon = await seedOrganisation('Cosdon');
  rival = await seedOrganisation('Rival');

  cosdonParcelId = await withTenant(cosdon.organisationId, async (tx) =>
    (await seedParcel(tx, cosdon, { reference: 'COS-1' })).id,
  );
  rivalParcelId = await withTenant(rival.organisationId, async (tx) =>
    (await seedParcel(tx, rival, { reference: 'RIV-1' })).id,
  );
});

afterAll(teardown);

describe('tenant isolation is enforced by the database, not only the query layer', () => {
  it('shows an organisation only its own stock', async () => {
    const seen = await withTenant(cosdon.organisationId, (tx) => listStockParcels(tx));
    expect(seen.map((p) => p.parcelReference)).toEqual(['COS-1']);
  });

  it('hides another organisation’s parcel even when its id is known exactly', async () => {
    const stolen = await withTenant(cosdon.organisationId, (tx) => getStockParcel(tx, rivalParcelId));
    expect(stolen).toBeNull();
  });

  it('hides another organisation’s sites', async () => {
    const sites = await withTenant(rival.organisationId, (tx) => listSites(tx));
    expect(sites).toHaveLength(1);
    expect(sites[0]?.name).toBe('Rival Site');
  });

  it('refuses a write that would place a row in another organisation', async () => {
    await expect(
      withTenant(rival.organisationId, (tx) =>
        tx.query('INSERT INTO bank_operator (organisation_id, name) VALUES ($1, $2)', [
          cosdon.organisationId,
          'Injected',
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses an update that would move a row into another organisation', async () => {
    await expect(
      withTenant(cosdon.organisationId, (tx) =>
        tx.query('UPDATE stock_parcel SET organisation_id = $1 WHERE id = $2', [
          rival.organisationId,
          cosdonParcelId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot delete another organisation’s rows', async () => {
    const result = await withTenant(rival.organisationId, (tx) =>
      tx.query('DELETE FROM stock_parcel WHERE id = $1', [cosdonParcelId]),
    );
    expect(result.rowCount).toBe(0);

    const stillThere = await withTenant(cosdon.organisationId, (tx) => getStockParcel(tx, cosdonParcelId));
    expect(stillThere).not.toBeNull();
  });

  it('rejects an organisation id that is not a UUID', async () => {
    await expect(withTenant("'; DROP TABLE quote; --", async () => undefined)).rejects.toThrow(/must be a UUID/);
  });
});

describe('the allocation management service (§3.1)', () => {
  it('grants a managing organisation access to the managed one’s stock', async () => {
    await grantManagement(rival.organisationId, cosdon.organisationId);

    const seen = await withTenant(cosdon.organisationId, (tx) => listStockParcels(tx));
    expect(seen.map((p) => p.parcelReference).sort()).toEqual(['COS-1', 'RIV-1']);
  });

  it('does not make the grant reciprocal', async () => {
    const seen = await withTenant(rival.organisationId, (tx) => listStockParcels(tx));
    expect(seen.map((p) => p.parcelReference)).toEqual(['RIV-1']);
  });

  it('conveys access to bank data but not to the client’s user accounts', async () => {
    const { rows } = await withTenant(cosdon.organisationId, (tx) =>
      tx.query<{ count: string }>('SELECT count(*) AS count FROM app_user WHERE organisation_id = $1', [
        rival.organisationId,
      ]),
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('lets a manager add stock to the organisation it manages', async () => {
    const parcel = await withTenant(cosdon.organisationId, (tx) =>
      seedParcel(tx, rival, { reference: 'RIV-MANAGED' }),
    );
    expect(parcel.organisationId).toBe(rival.organisationId);

    const rivalView = await withTenant(rival.organisationId, (tx) => listStockParcels(tx));
    expect(rivalView.map((p) => p.parcelReference).sort()).toEqual(['RIV-1', 'RIV-MANAGED']);
  });

  it('revoking a grant withdraws access immediately', async () => {
    await withTenant(rival.organisationId, (tx) =>
      tx.query(
        `UPDATE organisation_grant SET revoked_at = now()
          WHERE subject_organisation_id = $1 AND grantee_organisation_id = $2`,
        [rival.organisationId, cosdon.organisationId],
      ),
    );

    const seen = await withTenant(cosdon.organisationId, (tx) => listStockParcels(tx));
    expect(seen.map((p) => p.parcelReference)).toEqual(['COS-1']);
  });
});

describe('precision survives the round trip through Postgres (§2)', () => {
  it('returns quantities at the module’s own scale, not as floats', async () => {
    const parcel = await withTenant(cosdon.organisationId, async (tx) => {
      const created = await seedParcel(tx, cosdon, { reference: 'PREC-1', units: '2.34567' });
      return getStockParcel(tx, created.id);
    });

    expect(parcel?.totalUnits.toString()).toBe('2.3457');
    expect(parcel?.totalUnits).toBeInstanceOf(UnitQuantity);
  });

  it('keeps hedgerow at 3dp through storage and retrieval', async () => {
    const parcel = await withTenant(cosdon.organisationId, async (tx) => {
      const created = await seedParcel(tx, cosdon, { reference: 'PREC-2', module: 'hedgerow', units: '4.5678' });
      return getStockParcel(tx, created.id);
    });

    expect(parcel?.totalUnits.toString()).toBe('4.568');
  });

  it('rejects a quantity written to the database at the wrong scale', async () => {
    await expect(
      withTenant(cosdon.organisationId, (tx) =>
        tx.query(
          `INSERT INTO stock_parcel (organisation_id, site_id, parcel_reference, module,
                                     broad_habitat, habitat_type, distinctiveness, total_units)
           VALUES ($1, $2, 'BAD-SCALE', 'hedgerow', 'Hedgerow', 'Native hedgerow', 'medium', 1.2345)`,
          [cosdon.organisationId, cosdon.siteId],
        ),
      ),
    ).rejects.toThrow(/total_units_scale/);
  });

  it('refuses a parcel whose declared module disagrees with its quantity', async () => {
    await expect(
      withTenant(cosdon.organisationId, (tx) =>
        createStockParcel(tx, {
          organisationId: cosdon.organisationId,
          siteId: cosdon.siteId,
          parcelReference: 'MISMATCH',
          module: 'area',
          broadHabitat: 'Grassland',
          habitatType: 'Other neutral grassland',
          distinctiveness: 'medium',
          totalUnits: UnitQuantity.of('hedgerow', '1.0'),
        }),
      ),
    ).rejects.toThrow(/declared as area but its total units are a hedgerow quantity/);
  });
});
