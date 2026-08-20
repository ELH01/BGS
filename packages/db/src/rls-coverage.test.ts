import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, withoutTenantContext } from './client.js';
import { ensureTestSchema, seedOrganisation, teardown, type SeededOrg } from './test-support.js';

/**
 * Structural proof that tenant isolation covers everything, not only the
 * tables somebody remembered to write a test for.
 *
 * These tests read the live catalogue rather than a hand-maintained list, so a
 * table added later without row-level security fails the suite the moment it
 * exists. That matters more than any single test of a single endpoint: the
 * realistic way commercial data leaks out of a system like this is a new table
 * that nobody thought about.
 */

let alpha: SeededOrg;
let beta: SeededOrg;

/** Every table carrying an organisation_id, straight from the catalogue. */
async function tenantTables(): Promise<string[]> {
  return withoutTenantContext(async (db) => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attname = 'organisation_id'
          AND NOT a.attisdropped
        ORDER BY c.relname`,
    );
    return rows.map((row) => row.table_name);
  });
}

beforeAll(async () => {
  await ensureTestSchema();
  alpha = await seedOrganisation('RlsAlpha');
  beta = await seedOrganisation('RlsBeta');
});

afterAll(teardown);

describe('row-level security covers every tenant table', () => {
  it('finds the tenant tables from the catalogue, not from a list in a test', async () => {
    const tables = await tenantTables();
    // A sanity floor: if this ever collapses to a handful, the query is wrong
    // and the tests below would be vacuously passing.
    expect(tables.length).toBeGreaterThanOrEqual(14);
    expect(tables).toContain('quote');
    expect(tables).toContain('allocation_line');
    expect(tables).toContain('stock_parcel');
  });

  it('has row-level security ENABLED on every one of them', async () => {
    const tables = await tenantTables();
    const missing = await withoutTenantContext(async (db) => {
      const { rows } = await db.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND c.relname = ANY($1::text[])
            AND NOT c.relrowsecurity`,
        [tables],
      );
      return rows.map((row) => row.relname);
    });

    expect(missing, `tables without RLS enabled: ${missing.join(', ')}`).toEqual([]);
  });

  it('has row-level security FORCED, so even the table owner is filtered', async () => {
    const tables = await tenantTables();
    const missing = await withoutTenantContext(async (db) => {
      const { rows } = await db.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND c.relname = ANY($1::text[])
            AND NOT c.relforcerowsecurity`,
        [tables],
      );
      return rows.map((row) => row.relname);
    });

    expect(missing, `tables without FORCE RLS: ${missing.join(', ')}`).toEqual([]);
  });

  it('has at least one policy on every one of them', async () => {
    const tables = await tenantTables();
    const withoutPolicy = await withoutTenantContext(async (db) => {
      const { rows } = await db.query<{ tablename: string }>(
        `SELECT t.tablename
           FROM unnest($1::text[]) AS t(tablename)
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = t.tablename
          )`,
        [tables],
      );
      return rows.map((row) => row.tablename);
    });

    expect(withoutPolicy, `tables with no policy: ${withoutPolicy.join(', ')}`).toEqual([]);
  });

  it('runs the application as a role that cannot bypass any of it', async () => {
    const role = await withoutTenantContext(async (db) => {
      const { rows } = await db.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      return rows[0];
    });

    expect(role?.rolsuper, `application role ${role?.rolname} is a superuser`).toBe(false);
    expect(role?.rolbypassrls, `application role ${role?.rolname} can bypass RLS`).toBe(false);
  });
});

describe('one organisation cannot see another’s rows in any table', () => {
  it('returns nothing from any tenant table when no organisation context is set', async () => {
    const tables = await tenantTables();

    for (const table of tables) {
      const { rows } = await withoutTenantContext((db) =>
        db.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`),
      );
      expect(Number(rows[0]?.count), `${table} leaked rows with no organisation context`).toBe(0);
    }
  });

  it('never returns another organisation’s rows, table by table', async () => {
    const tables = await tenantTables();

    // Alpha writes one row into every table it can, then Beta looks for it.
    await withTenant(alpha.organisationId, async (tx) => {
      await tx.query(
        `INSERT INTO developer (organisation_id, purchasing_entity_name) VALUES ($1, 'Alpha Secret Developer')`,
        [alpha.organisationId],
      );
      await tx.query(
        `INSERT INTO audit_log (organisation_id, entity_type, entity_id, action, note)
         VALUES ($1, 'test', gen_random_uuid(), 'test', 'Alpha commercial secret')`,
        [alpha.organisationId],
      );
    });

    for (const table of tables) {
      const leaked = await withTenant(beta.organisationId, async (tx) => {
        const { rows } = await tx.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table} WHERE organisation_id = $1`,
          [alpha.organisationId],
        );
        return Number(rows[0]?.count ?? 0);
      });

      expect(leaked, `${table} leaked ${leaked} of Alpha's rows to Beta`).toBe(0);
    }
  });

  it('cannot be tricked into writing into another organisation, table by table', async () => {
    // Every tenant table's policy has a WITH CHECK, so an insert naming
    // another organisation is rejected rather than silently accepted.
    await expect(
      withTenant(beta.organisationId, (tx) =>
        tx.query(`INSERT INTO developer (organisation_id, purchasing_entity_name) VALUES ($1, 'Planted')`, [
          alpha.organisationId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      withTenant(beta.organisationId, (tx) =>
        tx.query(
          `INSERT INTO audit_log (organisation_id, entity_type, entity_id, action)
           VALUES ($1, 'test', gen_random_uuid(), 'planted')`,
          [alpha.organisationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('keeps the derived views filtered too', async () => {
    // A view defined without security_invoker would run as its owner and hand
    // over every tenant's stock levels.
    const invoker = await withoutTenantContext(async (db) => {
      const { rows } = await db.query<{ relname: string; options: string[] | null }>(
        `SELECT c.relname, c.reloptions AS options
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'v'`,
      );
      return rows;
    });

    expect(invoker.length).toBeGreaterThan(0);
    for (const view of invoker) {
      expect(
        (view.options ?? []).some((option) => option === 'security_invoker=true'),
        `view ${view.relname} is not security_invoker, so it would bypass the caller's row-level security`,
      ).toBe(true);
    }
  });
});

describe('the audit log cannot be rewritten', () => {
  it('refuses updates and deletes from the application role', async () => {
    await withTenant(alpha.organisationId, (tx) =>
      tx.query(
        `INSERT INTO audit_log (organisation_id, entity_type, entity_id, action)
         VALUES ($1, 'test', gen_random_uuid(), 'immutability-check')`,
        [alpha.organisationId],
      ),
    );

    await expect(
      withTenant(alpha.organisationId, (tx) => tx.query(`UPDATE audit_log SET note = 'rewritten'`)),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenant(alpha.organisationId, (tx) => tx.query('DELETE FROM audit_log')),
    ).rejects.toThrow(/permission denied/i);
  });
});
