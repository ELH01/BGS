import pg from 'pg';
import { loadDbConfig } from './config.js';

/**
 * Postgres `numeric` arrives as a string and is left that way.
 *
 * node-postgres would otherwise be the one place a fixed-precision value
 * became an IEEE double on its way out of the database, which is precisely
 * what §2 forbids. Callers convert to `UnitQuantity` or `Money` instead.
 */
pg.types.setTypeParser(1700, (value: string) => value);

export type QueryParam = string | number | boolean | Date | null | undefined | readonly string[];

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly QueryParam[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * A database handle already bound to one organisation's context.
 *
 * Every query made through it runs inside a transaction where
 * `app.organisation_id` is set, so Postgres row-level security filters results
 * to that organisation and the ones it holds management grants over. There is
 * no way to obtain one of these without naming an organisation.
 */
export interface TenantClient extends Queryable {
  readonly organisationId: string;
}

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const { appUrl } = loadDbConfig();
    pool = new pg.Pool({
      connectionString: appUrl,
      max: Number(process.env['DB_POOL_MAX'] ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (error) => {
      console.error('Idle database client error:', error.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run work in a transaction scoped to one organisation.
 *
 * The organisation id is applied with `set_config(..., is_local => true)`, so
 * it is bound to this transaction and cannot leak to the next borrower of the
 * pooled connection. The transaction commits on success and rolls back on any
 * thrown error.
 */
export async function withTenant<T>(
  organisationId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(organisationId)) {
    throw new TypeError('Organisation id must be a UUID.');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.organisation_id', organisationId]);

    const tx: TenantClient = {
      organisationId,
      query: (text, params) => client.query(text, params as unknown[]),
    };

    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already unusable; the pool will discard it.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run work with no organisation context, for the authentication steps that
 * necessarily precede one — logging in, resolving a session token, creating an
 * organisation.
 *
 * This is not a way around tenancy: without `app.organisation_id` set, every
 * row-level security policy evaluates to false, so ordinary tables return
 * nothing. Only the narrow SECURITY DEFINER functions in the `app` schema can
 * be used here, which is why the name is deliberately conspicuous.
 */
export async function withoutTenantContext<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn({ query: (text, params) => client.query(text, params as unknown[]) });
  } finally {
    client.release();
  }
}
