import { UnitQuantity } from '@bgs/core';
import { closePool, withTenant, type TenantClient } from './client.js';
import { loadDbConfig } from './config.js';
import { resetDatabase } from './migrate.js';
import { createBankOperator, createSite, createStockParcel } from './repositories.js';
import { createOrganisationWithOwner } from './auth-store.js';

export interface SeededOrg {
  organisationId: string;
  userId: string;
  bankOperatorId: string;
  siteId: string;
}

let migrated = false;

/** Migrate the test database once per run. */
export async function ensureTestSchema(): Promise<void> {
  if (migrated) return;
  const { migrationUrl } = loadDbConfig();
  await resetDatabase(migrationUrl);
  migrated = true;
}

export async function teardown(): Promise<void> {
  await closePool();
}

let counter = 0;

/** Create an organisation with an operator, a site and no stock. */
export async function seedOrganisation(name: string): Promise<SeededOrg> {
  counter += 1;
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${counter}`;

  const { organisationId, userId } = await createOrganisationWithOwner({
    organisationName: name,
    slug,
    quoteReferencePrefix: 'TQ',
    email: `owner-${counter}@example.test`,
    passwordHash: 'not-a-real-hash',
    displayName: `${name} Owner`,
  });

  return withTenant(organisationId, async (tx) => {
    const operator = await createBankOperator(tx, { organisationId, name: `${name} Banks` });
    const site = await createSite(tx, {
      organisationId,
      bankOperatorId: operator.id,
      name: `${name} Site`,
      lpaCode: 'E07000040',
      ncaCode: 'NCA148',
    });
    return { organisationId, userId, bankOperatorId: operator.id, siteId: site.id };
  });
}

export async function seedParcel(
  tx: TenantClient,
  org: SeededOrg,
  overrides: {
    reference?: string;
    module?: 'area' | 'hedgerow' | 'watercourse';
    units?: string;
    distinctiveness?: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
    habitatType?: string;
    broadHabitat?: string;
  } = {},
) {
  const module = overrides.module ?? 'area';
  counter += 1;
  return createStockParcel(tx, {
    organisationId: org.organisationId,
    siteId: org.siteId,
    parcelReference: overrides.reference ?? `P${counter}`,
    module,
    broadHabitat: overrides.broadHabitat ?? 'Grassland',
    habitatType: overrides.habitatType ?? 'Other neutral grassland',
    distinctiveness: overrides.distinctiveness ?? 'medium',
    totalUnits: UnitQuantity.of(module, overrides.units ?? '10.0'),
  });
}

/** Insert a quote with one allocation line, for exposure tests. */
export async function seedQuoteWithAllocation(
  tx: TenantClient,
  org: SeededOrg,
  input: { parcelId: string; module: 'area' | 'hedgerow' | 'watercourse'; quantity: string; status: string },
): Promise<string> {
  const { rows: devRows } = await tx.query<{ id: string }>(
    `INSERT INTO developer (organisation_id, purchasing_entity_name)
     VALUES ($1, 'Test Developer Ltd') RETURNING id`,
    [org.organisationId],
  );
  const developerId = devRows[0]?.id;
  if (!developerId) throw new Error('Failed to seed developer.');

  const { rows: refRows } = await tx.query<{ reference: string }>(
    'SELECT app.next_quote_reference($1) AS reference',
    [org.organisationId],
  );

  // Always inserted as a draft with no terminal timestamps: the quote table
  // requires each status to agree with its own timestamp, so those are set as
  // the ladder is walked below, exactly as the application does it.
  const { rows: quoteRows } = await tx.query<{ id: string }>(
    `INSERT INTO quote (organisation_id, reference, developer_id, status, spatial_scheme_id, buffer_percent)
     VALUES ($1, $2, $3, 'draft', 'lpa-nca-placeholder', 0.1)
     RETURNING id`,
    [org.organisationId, refRows[0]?.reference ?? 'TQ-0000', developerId],
  );
  const quoteId = quoteRows[0]?.id;
  if (!quoteId) throw new Error('Failed to seed quote.');

  const quantity = UnitQuantity.of(input.module, input.quantity);
  await tx.query(
    `INSERT INTO allocation_line (organisation_id, quote_id, stock_parcel_id, module, raw_quantity,
                                  spatial_band, spatial_factor, effective_units, unit_price, line_total)
     VALUES ($1,$2,$3,$4,$5,'same-lpa',1.0,$5,0,0)`,
    [org.organisationId, quoteId, input.parcelId, input.module, quantity.toString()],
  );

  // Walk the status ladder rather than writing the end state directly, so the
  // transition guard is exercised the same way the application exercises it.
  if (input.status !== 'draft') {
    await tx.query(`UPDATE quote SET status = 'quoted' WHERE id = $1`, [quoteId]);
  }
  if (input.status === 'reserved' || input.status === 'sold') {
    await tx.query(`UPDATE quote SET status = 'reserved', reserved_at = now() WHERE id = $1`, [quoteId]);
  }
  if (input.status === 'sold') {
    await tx.query(`UPDATE quote SET status = 'sold', sold_at = now() WHERE id = $1`, [quoteId]);
  }
  if (input.status === 'cancelled') {
    await tx.query(`UPDATE quote SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [quoteId]);
  }

  return quoteId;
}

export async function grantManagement(subjectOrgId: string, granteeOrgId: string): Promise<void> {
  await withTenant(subjectOrgId, (tx) =>
    tx.query(
      `INSERT INTO organisation_grant (subject_organisation_id, grantee_organisation_id, access)
       VALUES ($1, $2, 'manage')`,
      [subjectOrgId, granteeOrgId],
    ),
  );
}
